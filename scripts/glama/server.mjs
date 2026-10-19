// Glama's stdio evaluator talks to the real HTTP server and a disposable, loopback-only database.
// This entry point never accepts a remote endpoint, database URL, or existing credentials.
import { execFileSync, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chownSync, mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../", import.meta.url));
const directory = mkdtempSync(join(tmpdir(), "openuptime-glama-"));
console.error(`Glama sandbox directory: ${directory}`);
const data = join(directory, "pgdata");
const pgBin = execFileSync("pg_config", ["--bindir"], { encoding: "utf8" }).trim();
const asPostgres = process.getuid?.() === 0;
if (asPostgres) {
  const uid = Number(execFileSync("id", ["-u", "postgres"], { encoding: "utf8" }).trim());
  const gid = Number(execFileSync("id", ["-g", "postgres"], { encoding: "utf8" }).trim());
  chownSync(directory, uid, gid);
}
const pg = (command, args) => {
  const executable = join(pgBin, command);
  return execFileSync(asPostgres ? "runuser" : executable, asPostgres ? ["-u", "postgres", "--", executable, ...args] : args,
    { cwd: directory, stdio: ["ignore", "ignore", "inherit"], timeout: 60_000 });
};
const freePort = () => new Promise((resolvePort, reject) => {
  const socket = createServer();
  socket.on("error", reject);
  socket.listen(0, "127.0.0.1", () => {
    const port = socket.address().port;
    socket.close((error) => error ? reject(error) : resolvePort(port));
  });
});

let api;
let postgresStarted = false;
let stopping;
async function stop() {
  if (stopping) return stopping;
  stopping = (async () => {
    if (api && api.exitCode === null && api.signalCode === null) {
      const exited = new Promise((done) => api.once("exit", done));
      const kill = setTimeout(() => api.kill("SIGKILL"), 10_000);
      api.kill("SIGTERM");
      await exited;
      clearTimeout(kill);
    }
    if (postgresStarted) pg("pg_ctl", ["-D", data, "-m", "immediate", "-w", "stop"]);
    rmSync(directory, { recursive: true, force: true });
    console.error("Glama sandbox removed");
  })();
  return stopping;
}
for (const signal of ["SIGTERM", "SIGINT"]) process.once(signal, () => {
  void stop().finally(() => process.exit(0));
});

async function start() {
  pg("initdb", ["-D", data, "-U", "openuptime", "--auth=trust", "--encoding=UTF8", "--no-locale"]);
  const databasePort = await freePort();
  pg("pg_ctl", ["-D", data, "-l", join(directory, "postgres.log"), "-o", `-h 127.0.0.1 -p ${databasePort} -k ${directory}`, "-w", "start"]);
  postgresStarted = true;
  pg("createdb", ["-h", "127.0.0.1", "-p", String(databasePort), "-U", "openuptime", "openuptime"]);
  const apiPort = await freePort();
  const origin = `http://127.0.0.1:${apiPort}`;
  // Deliberate allowlist: a developer's SMTP/probe/cloud/production settings must not reach this sandbox.
  api = spawn(process.execPath, [resolve(root, "apps/api/dist/glama-api.mjs")], {
    cwd: directory,
    env: {
      PATH: process.env.PATH,
      NODE_ENV: "production",
      PORT: String(apiPort),
      DATABASE_URL: `postgres://openuptime@127.0.0.1:${databasePort}/openuptime`,
      BETTER_AUTH_SECRET: randomBytes(32).toString("hex"),
      BETTER_AUTH_URL: origin,
      WEB_ORIGIN: origin,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  api.stdout.pipe(process.stderr);
  api.stderr.pipe(process.stderr);
  let spawnError;
  api.on("error", (error) => { spawnError = error; });
  const deadline = Date.now() + 60_000;
  for (;;) {
    if (spawnError) throw spawnError;
    if (api.exitCode !== null) throw new Error("Sandbox API exited before becoming ready");
    try {
      if ((await fetch(`${origin}/health`, { signal: AbortSignal.timeout(1000) })).ok) break;
    } catch { /* Wait for migrations and the HTTP listener. */ }
    if (Date.now() > deadline) throw new Error("Sandbox API startup timed out");
    await new Promise((done) => setTimeout(done, 100));
  }
  const signup = await fetch(`${origin}/api/auth/sign-up/email`, {
    method: "POST",
    headers: { "content-type": "application/json", origin },
    body: JSON.stringify({ email: "evaluator@example.invalid", name: "Glama sandbox", password: randomBytes(32).toString("hex") }),
  });
  if (!signup.ok) {
    const error = await signup.json().catch(() => ({}));
    throw new Error(`Sandbox signup failed (${signup.status}): ${error.message ?? "unknown error"}`);
  }
  const cookie = signup.headers.getSetCookie().map((item) => item.split(";")[0]).join("; ");
  if (!cookie) throw new Error("Sandbox signup did not issue a session");
  const me = await fetch(`${origin}/api/me`, { headers: { cookie } });
  if (!me.ok) throw new Error(`Sandbox session rejected (${me.status})`);
  console.error("Glama sandbox ready: disposable Postgres, authenticated local MCP endpoint");
  return { endpoint: `${origin}/api/mcp`, cookie };
}

// Attach before startup: clients may send initialize while Postgres is still starting.
const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
const ready = start();
let queue = Promise.resolve();
let failed = false;
ready.catch((error) => {
  failed = true;
  console.error(error.message);
  input.close();
  void stop().finally(() => process.exit(1));
});
input.on("line", (line) => {
  if (!line.trim()) return;
  queue = queue.then(async () => {
    let message;
    try { message = JSON.parse(line); }
    catch {
      process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } }) + "\n");
      return;
    }
    const { endpoint, cookie } = await ready;
    try {
      const response = await fetch(endpoint, {
        method: "POST",
        headers: { cookie, "content-type": "application/json", accept: "application/json, text/event-stream" },
        body: JSON.stringify(message),
        signal: AbortSignal.timeout(60_000),
      });
      // HTTP notifications have no JSON-RPC response, including initialized/cancelled.
      if (response.status === 202 || response.status === 204) return;
      const body = await response.text();
      if (!body) return;
      const result = JSON.parse(body);
      process.stdout.write(JSON.stringify(result) + "\n");
    } catch (error) {
      console.error("Sandbox request failed:", error.message);
      if (message && Object.hasOwn(message, "id")) process.stdout.write(JSON.stringify({
        jsonrpc: "2.0", id: message.id, error: { code: -32603, message: "Sandbox HTTP request failed" },
      }) + "\n");
    }
  }).catch((error) => { failed = true; console.error(error.message); });
});
input.on("close", () => {
  void queue.then(() => ready).then(stop).then(() => process.exit(failed ? 1 : 0), async (error) => {
    console.error(error.message);
    await stop();
    process.exit(1);
  });
});
