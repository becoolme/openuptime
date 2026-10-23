import { openDatabase } from "@openuptime/db-pg";
import { describe, expect, it } from "vitest";
import { createApp } from "./app";

// Runs only when TEST_DATABASE_URL points at a database (shared with the other end-to-end tests).
const url = process.env.TEST_DATABASE_URL;
const ORIGIN = "http://localhost:8787";
const env = { DATABASE_URL: url, BETTER_AUTH_SECRET: "test-secret-test-secret-test-secret-123", BETTER_AUTH_URL: ORIGIN, WEB_ORIGIN: ORIGIN, CRON_SECRET: "cron" };

describe.skipIf(!url)("status page feeds, calendar, llms.txt and public MCP", () => {
  const app = createApp(openDatabase);
  const raw = (path: string, init: RequestInit = {}) => app.fetch(new Request(`${ORIGIN}${path}`, init), env as never);
  const rpc = (path: string, body: unknown, headers: Record<string, string> = {}) =>
    raw(path, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });

  it("serves the badge, RSS, ICS and llms.txt of a page, escapes owner text, and keeps the MCP switch", async () => {
    await raw("/internal/migrate", { method: "POST", headers: { "x-cron-secret": "cron" } });
    const su = await raw("/api/auth/sign-up/email", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: `feeds-${Date.now()}@example.com`, password: "correct horse battery", name: "Ada" }),
    });
    const cookie = su.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
    const call = async (method: string, path: string, body?: unknown) => {
      const r = await raw(`/api${path}`, { method, headers: { cookie, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
      return { status: r.status, body: (await r.json().catch(() => null)) as any };
    };
    const mon = (await call("POST", "/monitors", { name: "API", type: "http", target: "https://example.com", intervalSec: 60 })).body;
    const slug = `f${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;
    const nasty = `Ops & <b>"x"</b> 'y'`;
    const page = await call("POST", "/status-pages", { slug, title: nasty, monitorIds: [mon.id] });
    expect(page.status).toBe(201);
    const inc = await call("POST", "/incidents", { monitorId: mon.id, title: `Down <script>&`, status: "investigating", body: "we are looking" });
    expect([200, 201]).toContain(inc.status);
    const start = new Date(Date.now() + 36e5 * 48);
    const made = await call("POST", "/maintenance", { name: "DB; upgrade, now", startsAt: start.toISOString(), endsAt: new Date(+start + 36e5).toISOString(), monitorIds: [mon.id] });
    expect(made.status).toBe(201);

    const badge = await raw(`/api/public/status/${slug}/badge.svg`);
    expect(badge.headers.get("content-type")).toContain("image/svg+xml");
    expect(badge.headers.get("cache-control")).toContain("max-age=60");

    const rss = await raw(`/api/public/status/${slug}/rss.xml`);
    expect(rss.headers.get("content-type")).toContain("xml");
    const xml = await rss.text();
    expect(xml).toContain("[Incident] Down &lt;script&gt;&amp;");
    expect(xml).toContain("[Maintenance] DB; upgrade, now");
    expect(xml).toContain("Ops &amp; &lt;b&gt;&quot;x&quot;&lt;/b&gt; &apos;y&apos;");
    expect(xml).not.toContain("<script>");

    const ics = await (await raw(`/api/public/status/${slug}/maintenance.ics`)).text();
    expect(ics).toContain("BEGIN:VCALENDAR");
    expect(ics).toContain("SUMMARY:Maintenance: DB\\; upgrade\\, now");

    const llms = await (await raw(`/api/public/status/${slug}/llms.txt`)).text();
    expect(llms).toContain("API");
    expect(llms).toContain("/api/mcp/public");

    // the public MCP endpoint needs no credentials and lists only the read-only status page tools
    const listed: any = await (await rpc("/api/mcp/public", { jsonrpc: "2.0", id: 1, method: "tools/list" })).json();
    expect(listed.result.tools.map((t: any) => t.name).sort()).toEqual(["get_public_status_page", "list_public_status_page_incidents", "list_public_status_page_maintenance"]);
    const overview: any = await (await rpc("/api/mcp/public", { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "status_page_overview", arguments: { slug } } })).json();
    expect(overview.result.isError).toBeFalsy();
    expect(JSON.parse(overview.result.content[0].text).page.slug).toBe(slug);
    const priv = await rpc("/api/mcp/public", { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "list_monitors", arguments: {} } });
    expect(((await priv.json()) as any).error.code).toBe(-32602);
    // the authenticated endpoint still wants credentials
    expect((await rpc("/api/mcp", { jsonrpc: "2.0", id: 4, method: "tools/list" })).status).toBe(401);

    const wk: any = await (await raw("/.well-known/mcp.json")).json();
    expect(wk.endpoints.map((e: any) => e.url)).toEqual([`${ORIGIN}/api/mcp`, `${ORIGIN}/api/mcp/public`]);

    // the owner can switch MCP reads off; the page itself stays public
    expect((await call("PATCH", `/status-pages/${page.body.id}`, { mcpEnabled: false })).status).toBe(200);
    const off: any = await (await rpc("/api/mcp/public", { jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "status_page_overview", arguments: { slug } } })).json();
    expect(off.result.isError).toBe(true);
    expect((await raw(`/api/public/status/${slug}`)).status).toBe(200);
    expect(await (await raw(`/api/public/status/${slug}/llms.txt`)).text()).not.toContain("/api/mcp/public");

    // thresholds: amber must sit below green
    expect((await call("PATCH", `/status-pages/${page.body.id}`, { uptimeOkPct: 99, uptimeWarnPct: 99.5 })).status).toBe(400);
    expect((await call("PATCH", `/status-pages/${page.body.id}`, { uptimeOkPct: 99.9, uptimeWarnPct: 98 })).status).toBe(200);

    expect((await raw(`/api/public/status/nope-${slug}/rss.xml`)).status).toBe(404);
  });
});
