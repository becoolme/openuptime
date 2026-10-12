import type { OpenDatabase } from "@openuptime/repo";
import { isLang } from "./mail-i18n";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { HTTPException } from "hono/http-exception";
import { createAuth, signupDisabled, slugify } from "./auth";
import { connectionString, type AppEnv } from "./env";
import { mountMcp } from "./mcp-route";
import { requireOrg } from "./middleware";
import { alertLog, settings } from "./routes/alert-log";
import { channels } from "./routes/channels";
import { incidents } from "./routes/incidents";
import { maintenance } from "./routes/maintenance";
import { monitors } from "./routes/monitors";
import { projects } from "./routes/projects";
import { publicStatus, statusPages } from "./routes/status";
import { configureEmail } from "./email";
import { configureNetGuard } from "./netguard";
import { community, type Edition } from "./edition";
import { nextAfter, resolveIncident, runDueChecks } from "./scheduler";

export function createApp(openDatabase: OpenDatabase, options: { edition?: Edition } = {}) {
  const edition = options.edition ?? community;
  const app = new Hono<AppEnv>();

  // the database and auth are created per request: required on Workers (no cross-request I/O objects).
  app.use("*", async (c, next) => {
    configureEmail(c.env);
    configureNetGuard(c.env);
    const database = openDatabase(connectionString(c.env), { max: 1 });
    c.set("repo", database.repo);
    c.set("database", database);
    c.set("auth", createAuth(database, c.env));
    c.set("entitlements", edition.entitlements({ database, env: c.env }));
    try {
      await next();
    } finally {
      const close = database.close(1);
      try {
        c.executionCtx.waitUntil(close); // Workers
      } catch {
        await close; // Node has no ExecutionContext
      }
    }
  });

  const privateCors = cors({
    origin: (origin, c) => (origin === c.env.WEB_ORIGIN ? origin : null),
    credentials: true,
    allowHeaders: ["content-type", "authorization", "x-api-key", "x-project-id", "x-workspace-id", "mcp-protocol-version", "mcp-session-id"],
    allowMethods: ["GET", "POST", "PATCH", "DELETE", "OPTIONS"],
  });
  // status summaries and badges are public reads meant to be embedded on any site
  const publicCors = cors({ origin: "*", allowMethods: ["GET", "OPTIONS"], maxAge: 86400 });
  app.use("/api/*", (c, next) => (c.req.path.startsWith("/api/public/status/") && c.req.method !== "POST" ? publicCors(c, next) : privateCors(c, next)));

  // discovery documents are public and read by browser-based agent clients too
  app.use("/.well-known/*", cors({ origin: "*", allowMethods: ["GET"] }));

  app.get("/health", (c) => c.json({ ok: true }));
  app.get("/api/health", (c) => c.json({ ok: true }));
  app.get("/api/auth-providers", (c) => c.json({ github: !!(c.env.GITHUB_CLIENT_ID && c.env.GITHUB_CLIENT_SECRET), signup: !signupDisabled(c.env) }));
  app.on(["GET", "POST"], "/api/auth/*", (c) => c.get("auth").handler(c.req.raw));

  // public
  app.route("/api/public/status", publicStatus);
  app.on(["GET", "POST"], "/api/heartbeat/:token", async (c) => {
    const repo = c.get("repo");
    const m = await repo.monitorByHeartbeatToken(c.req.param("token"));
    if (!m) return c.json({ error: "Unknown token" }, 404);
    // a paused monitor stays paused: the ping is acknowledged but changes nothing
    if (m.status === "paused") return c.json({ ok: true, paused: true });
    await repo.recordCheck({ monitorId: m.id, ok: true });
    const wasDown = m.status === "down";
    // the status stays "down" until the incident is resolved, so a failed resolve is retried by the next ping
    await repo.setMonitorState(m.id, { ...(wasDown ? {} : { status: "up" as const }), consecutiveFailures: 0, lastCheckedAt: new Date(), nextCheckAt: nextAfter(m) });
    if (wasDown) {
      await resolveIncident(repo, m, false, c.get("entitlements"));
      await repo.setMonitorState(m.id, { status: "up" });
    }
    return c.json({ ok: true });
  });

  // trigger checks from an external scheduler when Workers Cron is not available
  app.post("/internal/run-checks", async (c) => {
    if (!c.env.CRON_SECRET || c.req.header("x-cron-secret") !== c.env.CRON_SECRET) return c.json({ error: "Forbidden" }, 403);
    return c.json({ checked: await runDueChecks(c.get("repo"), c.env.CHECK_QUEUE, c.get("entitlements")) });
  });

  // applies pending migrations over HTTP, for deployments that cannot run `pnpm db:migrate` from a shell
  app.post("/internal/migrate", async (c) => {
    if (!c.env.CRON_SECRET || c.req.header("x-cron-secret") !== c.env.CRON_SECRET) return c.json({ error: "Forbidden" }, 403);
    const database = c.get("database");
    return c.json({ applied: [...(await database.migrate()), ...((await edition.migrate?.(database)) ?? [])] });
  });

  mountMcp(app);

  // the authorization screen's picker: the signed-in user's workspaces with their projects (before any workspace is active)
  app.get("/api/oauth/picker", async (c) => {
    const session = await c.get("auth").api.getSession({ headers: c.req.raw.headers });
    if (!session) return c.json({ error: "Unauthorized" }, 401);
    const repo = c.get("repo");
    const spaces = await repo.workspacesOf(session.user.id);
    const active = (session.session as { activeOrganizationId?: string | null }).activeOrganizationId;
    return c.json({
      active: active && spaces.some((w) => w.id === active) ? active : (spaces[0]?.id ?? null),
      workspaces: await Promise.all(spaces.map(async (w) => ({ ...w, projects: (await repo.listProjects(w.id, null)).map((p) => ({ id: p.id, name: p.name })) }))),
    });
  });

  // authenticated
  const authed = new Hono<AppEnv>();
  authed.use("*", requireOrg);
  authed.route("/projects", projects);
  authed.route("/monitors", monitors);
  authed.route("/incidents", incidents);
  authed.route("/channels", channels);
  authed.route("/alert-log", alertLog);
  authed.route("/settings", settings);
  authed.route("/maintenance", maintenance);
  authed.route("/status-pages", statusPages);
  // what this credential may reach: a session sees every workspace of the user, a key or an agent only what it was given
  authed.get("/workspaces", async (c) => {
    const repo = c.get("repo");
    const granted = c.get("workspaceGrant");
    let spaces = await repo.workspacesOf(c.get("userId"));
    if (granted instanceof Map) spaces = spaces.filter((w) => granted.has(w.id));
    const workspaces = await Promise.all(
      spaces.map(async (w) => ({
        id: w.id,
        name: w.name,
        projects: (await repo.listProjects(w.id, granted instanceof Map ? (granted.get(w.id) ?? null) : null)).map((p) => ({ id: p.id, name: p.name })),
      })),
    );
    return c.json({ current: { workspace: c.get("orgId"), project: c.get("projectId") }, workspaces });
  });
  // a new workspace (with its first project): for sessions and for agents authorized for every workspace, never for
  // keys or agents that were given specific workspaces
  authed.post("/workspaces", async (c) => {
    const granted = c.get("workspaceGrant");
    if (granted !== null && granted !== "all") return c.json({ error: "This API key or authorization is limited to specific workspaces" }, 403);
    const name = String(((await c.req.json().catch(() => null)) as { name?: unknown } | null)?.name ?? "").trim();
    if (!name || name.length > 60) return c.json({ error: "name must be 1 to 60 characters" }, 400);
    const repo = c.get("repo");
    const userId = c.get("userId");
    if ((await repo.ownedWorkspaces(userId)).length >= 10) return c.json({ error: "You can own at most 10 workspaces" }, 400);
    const id = crypto.randomUUID();
    await repo.createPersonalWorkspace({ id, name, slug: slugify(name), ownerId: userId });
    return c.json({ id, name, projects: (await repo.listProjects(id, null)).map((p) => ({ id: p.id, name: p.name })) }, 201);
  });
  authed.get("/me", async (c) => {
    const repo = c.get("repo");
    const [organization, user] = await Promise.all([repo.organization(c.get("orgId")), repo.userProfile(c.get("userId"))]);
    return c.json({ userId: c.get("userId"), user, organization, projectId: c.get("projectId") });
  });
  // everything we hold about this user (GDPR export); workspace contents only for workspaces they own or administer
  // interactive sessions only: an API key or agent token (even a project-limited one) never gets the whole account
  authed.get("/me/export", async (c) => {
    if (c.get("workspaceGrant") !== null) return c.json({ error: "Account export needs a signed-in session, not an API key or agent authorization" }, 403);
    c.header("content-disposition", 'attachment; filename="openuptime-account-export.json"');
    return c.json({ exportedAt: new Date().toISOString(), ...(await c.get("repo").exportAccount(c.get("userId"))) });
  });
  // preferred language for emails sent to this user
  authed.patch("/me/locale", async (c) => {
    if (c.get("workspaceGrant") !== null) return c.json({ error: "This needs a signed-in session, not an API key or agent authorization" }, 403);
    const body = (await c.req.json().catch(() => null)) as { locale?: unknown } | null;
    if (!isLang(body?.locale)) return c.json({ error: "Unsupported language" }, 400);
    await c.get("repo").setUserLocale(c.get("userId"), body.locale);
    return c.json({ locale: body.locale });
  });
  // plan, allowances and usage of the active workspace; `metered: false` when this deployment has no plans or limits
  authed.get("/usage", async (c) => {
    const e = c.get("entitlements");
    const orgId = c.get("orgId");
    const [credits, emails, plan, activeMonitors] = await Promise.all([e.creditBalance(orgId), e.emailBalance(orgId), e.plan(orgId), c.get("repo").activeMonitorCount(orgId)]);
    if (!credits && !emails && !plan) return c.json({ metered: false });
    return c.json({ metered: true, ...(credits ?? {}), credits, emails, plan, activeMonitors });
  });
  // sidebar badges: one round trip, four counts
  authed.get("/counts", async (c) => c.json(await c.get("repo").counts(c.get("orgId"), c.get("projectId"))));
  edition.mount?.({ app, authed });
  app.route("/api", authed);

  app.onError((err, c) => {
    if (err instanceof HTTPException) return c.json({ error: err.message }, err.status);
    console.error(err);
    return c.json({ error: "Internal error" }, 500);
  });
  return app;
}

export type AppType = ReturnType<typeof createApp>;
