import { openDatabase } from "@openuptime/db-pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "./app";

const url = process.env.TEST_DATABASE_URL;
const origin = "http://localhost:8787";
const env = { DATABASE_URL: url, BETTER_AUTH_SECRET: "status-extras-secret-not-for-production", BETTER_AUTH_URL: origin, WEB_ORIGIN: origin };

describe.skipIf(!url)("status page stylesheet, day incidents and uptime ranges", () => {
  const db = url ? openDatabase(url, { max: 3 }) : null;
  const app = createApp(openDatabase);
  beforeAll(async () => { await db!.migrate(); });
  afterAll(async () => { await db?.close(1); });
  const raw = (path: string) => app.fetch(new Request(origin + path), env as never);
  async function account() {
    const signup = await app.fetch(new Request(origin + "/api/auth/sign-up/email", { method: "POST", headers: { origin, "content-type": "application/json" }, body: JSON.stringify({ email: `extras-${crypto.randomUUID()}@example.com`, password: "correct horse battery", name: "Extras" }) }), env as never);
    const cookie = signup.headers.getSetCookie().map((v) => v.split(";")[0]).join("; ");
    return async (method: string, path: string, body?: unknown) => {
      const res = await app.fetch(new Request(origin + "/api" + path, { method, headers: { origin, "content-type": "application/json", cookie }, body: body === undefined ? undefined : JSON.stringify(body) }), env as never);
      return { status: res.status, body: await res.json().catch(() => null) as any };
    };
  }
  const slugOf = () => `x${crypto.randomUUID().slice(0, 12)}`;

  it("stores a safe stylesheet without its comments, refuses a harmful one and shows it on the public page", async () => {
    const call = await account();
    const slug = slugOf();
    const page = (await call("POST", "/status-pages", { slug, title: "Styled", customCss: "/* brand */ .pub-hd h1 { color: #123456 }" })).body;
    expect((await call("GET", `/status-pages/${page.id}`)).body.customCss).toBe(".pub-hd h1 { color: #123456 }");
    // stripping comments once turns this into `[x="/*"]`, which must not hide the url() after it
    expect((await call("PATCH", `/status-pages/${page.id}`, { customCss: '[x="//**/*"]{} c{background:url(//e.example/x)}' })).status).toBe(400);
    const refused = await call("PATCH", `/status-pages/${page.id}`, { customCss: "body { background: url(https://x.example/t.gif) }" });
    expect(refused.status).toBe(400);
    expect(JSON.stringify(refused.body)).toContain("url()");
    expect((await (await raw(`/api/public/status/${slug}`)).json() as any).page.customCss).toBe(".pub-hd h1 { color: #123456 }");
    expect((await call("PATCH", `/status-pages/${page.id}`, { customCss: "  " })).status).toBe(200);
    expect((await (await raw(`/api/public/status/${slug}`)).json() as any).page.customCss).toBeNull();
  });

  it("lists the incidents open on a day, each with its component", async () => {
    const call = await account();
    const slug = slugOf();
    const mon = (await call("POST", "/monitors", { name: "API", type: "http", target: "https://1.1.1.1/" })).body;
    await call("POST", "/status-pages", { slug, title: "Days", monitorIds: [mon.id] });
    const own = (await call("POST", "/incidents", { title: "API slow", monitorId: mon.id })).body;
    await call("POST", "/incidents", { title: "Everything slow" });
    const today = new Date().toISOString().slice(0, 10);
    const res = await raw(`/api/public/status/${slug}/incidents?day=${today}`);
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.day).toBe(today);
    expect(body.items.map((i: any) => [i.title, i.componentId]).sort()).toEqual([["API slow", mon.id], ["Everything slow", null]]);
    expect(body.items.find((i: any) => i.id === own.id)).not.toHaveProperty("organizationId");
    const longAgo = new Date(Date.now() - 30 * 864e5).toISOString().slice(0, 10);
    expect((await (await raw(`/api/public/status/${slug}/incidents?day=${longAgo}`)).json() as any).items).toEqual([]);
    for (const bad of ["2026-02-31", "yesterday", "2001-01-01", new Date(Date.now() + 3 * 864e5).toISOString().slice(0, 10)])
      expect((await raw(`/api/public/status/${slug}/incidents?day=${bad}`)).status).toBe(400);
  });

  it("reports 7- and 30-day uptime alongside 90 days", async () => {
    const call = await account();
    const slug = slugOf();
    const mon = (await call("POST", "/monitors", { name: "API", type: "http", target: "https://1.1.1.1/" })).body;
    await call("POST", "/status-pages", { slug, title: "Ranges", monitorIds: [mon.id] });
    const comp = ((await (await raw(`/api/public/status/${slug}`)).json()) as any).components[0];
    // no history yet, so the page is hourly and the shorter ranges are not offered
    expect(comp).toMatchObject({ uptime90d: null, uptime7d: null, uptime30d: null });
  });
});
