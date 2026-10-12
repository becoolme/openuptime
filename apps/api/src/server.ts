import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { getRequestListener } from "@hono/node-server";
import { openDatabase } from "@openuptime/db-pg";
import type { Database, OpenDatabase } from "@openuptime/repo";
import nodemailer from "nodemailer";
import sirv from "sirv";
import { createApp } from "./app";
import { configureEmail, setMailTransport } from "./email";
import { configureNetGuard } from "./netguard";
import { configureProbes } from "./probes";
import { community, type Edition } from "./edition";
import type { Bindings } from "./env";
import { processCheckMessage, runDueChecks, type CheckMessage, type CheckQueue } from "./scheduler";

/**
 * Self-hosted entry point (Docker): one Node process serving the API, the Astro web build and the check
 * scheduler, against a single long-lived Postgres pool.
 */
const env = process.env as unknown as Bindings & Record<string, string | undefined>;
const need = (k: string) => {
  if (!env[k]) throw new Error(`${k} is required`);
  return env[k]!;
};
const port = Number(env.PORT ?? 8080);
const databaseUrl = need("DATABASE_URL");
// the placeholder from .env.docker.example must never reach production: it would let anyone forge sessions
for (const k of ["BETTER_AUTH_SECRET", "CRON_SECRET"] as const) {
  const v = env[k];
  if (v && (/^change-me/i.test(v) || v.length < 16)) throw new Error(`${k} is a placeholder or too short: generate one with \`openssl rand -hex 32\``);
}
need("BETTER_AUTH_SECRET");
env.BETTER_AUTH_URL ||= env.WEB_ORIGIN || `http://localhost:${port}`;
env.WEB_ORIGIN ||= env.BETTER_AUTH_URL;
// SSR pages of the web build call the API over loopback
process.env.API_ORIGIN ||= `http://127.0.0.1:${port}`;

// SMTP (any provider; RESEND_API_KEY is a shortcut for Resend): either one SMTP_URL (smtps://user:pass@host:465, smtp://host:587?...) or discrete SMTP_HOST/PORT/USER/PASS/SECURE
const smtpConfig = env.SMTP_URL
  ? env.SMTP_URL
  : env.RESEND_API_KEY && !env.SMTP_HOST
    ? { host: "smtp.resend.com", port: 465, secure: true, auth: { user: "resend", pass: env.RESEND_API_KEY } } // Resend's SMTP relay
  : env.SMTP_HOST
    ? {
        host: env.SMTP_HOST,
        port: Number(env.SMTP_PORT ?? (env.SMTP_SECURE === "true" ? 465 : 587)),
        secure: env.SMTP_SECURE === "true", // true = implicit TLS (465); false = STARTTLS when offered (587/25)
        ...(env.SMTP_USER ? { auth: { user: env.SMTP_USER, pass: env.SMTP_PASS ?? "" } } : {}),
      }
    : undefined;
if (smtpConfig) {
  if (!env.EMAIL_FROM) console.warn("SMTP is configured but EMAIL_FROM is not set: emails will only be logged");
  else {
    const smtp = nodemailer.createTransport(smtpConfig);
    setMailTransport((m) => smtp.sendMail({ from: { name: m.fromName, address: m.from }, to: m.to, subject: m.subject, html: m.html, text: m.text }));
    // report a bad host/credentials at startup instead of on the first invitation; never fatal
    smtp.verify().then(
      () => console.log("smtp: connection verified"),
      (e) => console.warn(`smtp: cannot connect (${(e as Error).message}); emails will fail until this is fixed`),
    );
  }
}
configureEmail(env);
configureNetGuard(env);
configureProbes(env);

const database: Database = openDatabase(databaseUrl, { max: Number(env.DB_POOL_MAX) || 10 });
/** The app opens and closes a database per request (Workers); here every request shares the one pool. */
const shared: OpenDatabase = () => ({ ...database, close: async () => {} });
/** The edition: self-hosted is the open-source one, unmetered. */
const edition: Edition = community;
const entitlements = edition.entitlements({ database, env: env as never });
const app = createApp(shared, { edition });

// in-process stand-in for the Cloudflare Queue: same packing and slot delays, executed in this process
const CHECK_CONCURRENCY = 4;
let running = 0;
const waiting: CheckMessage[] = [];
const pump = () => {
  while (running < CHECK_CONCURRENCY && waiting.length) {
    const msg = waiting.shift()!;
    running++;
    processCheckMessage(database.repo, msg, entitlements)
      .catch((e) => console.error("check batch failed", e))
      .finally(() => {
        running--;
        pump();
      });
  }
};
const queue: CheckQueue = {
  async sendBatch(messages) {
    for (const m of messages) {
      setTimeout(() => {
        waiting.push(m.body);
        pump();
      }, (m.delaySeconds ?? 0) * 1000).unref();
    }
  },
};

// the web build is optional so the API can also run on its own
const webDist = resolve(env.WEB_DIST ?? "web");
type NodeHandler = (req: IncomingMessage, res: ServerResponse, next: (err?: unknown) => void) => void;
let astro: NodeHandler | undefined;
let assets: NodeHandler | undefined;
try {
  astro = (await import(pathToFileURL(`${webDist}/server/entry.mjs`).href)).handler;
  assets = sirv(`${webDist}/client`, { etag: true, maxAge: 0 }) as NodeHandler;
} catch (e) {
  console.warn(`web build not found in ${webDist}; serving the API only`, (e as Error).message);
}

const honoListener = getRequestListener((req) => app.fetch(req, env));
const isApi = (url = "") => /^\/(api|internal|health|\.well-known)(\/|\?|$)/.test(url);

const server = createServer((req, res) => {
  if (isApi(req.url) || !astro || !assets) return void honoListener(req, res);
  // hashed /_astro files are immutable; sirv answers other static files and falls through for SSR routes
  assets(req, res, () => astro!(req, res, (err) => {
    res.statusCode = err ? 500 : 404;
    res.end(err ? "Internal error" : "Not found");
  }));
});

// retry: on a fresh `docker compose up` Postgres may still be starting
for (let attempt = 1; ; attempt++) {
  try {
    const applied = await database.migrate();
    if (applied.length) console.log(`migrations applied: ${applied.join(", ")}`);
    break;
  } catch (e) {
    if (attempt >= 30) throw e;
    console.warn(`database not ready (${(e as Error).message}); retrying`);
    await new Promise((r) => setTimeout(r, 2000));
  }
}

server.listen(port, () => console.log(`openuptime → ${env.WEB_ORIGIN} (listening on :${port})`));

let ticking = false;
const tick = setInterval(async () => {
  if (ticking) return; // a long tick must not overlap the next one
  ticking = true;
  try {
    await runDueChecks(database.repo, queue, entitlements);
  } catch (e) {
    console.error("scheduler", e);
  } finally {
    ticking = false;
  }
}, 30_000);

const stop = () => {
  clearInterval(tick);
  server.close();
  database.close(5).finally(() => process.exit(0));
  setTimeout(() => process.exit(0), 8000).unref();
};
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
