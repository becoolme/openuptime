import { openDatabase } from "@openuptime/db-pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "./app";
import { setMailTransport } from "./email";

// Runs only when TEST_DATABASE_URL points at a database (shared with the other end-to-end tests).
const url = process.env.TEST_DATABASE_URL;
const ORIGIN = "http://localhost:8787";
const env = {
  DATABASE_URL: url, BETTER_AUTH_SECRET: "test-secret-test-secret-test-secret-123", BETTER_AUTH_URL: ORIGIN, WEB_ORIGIN: ORIGIN, CRON_SECRET: "cron",
  EMAIL_FROM: "alerts@example.com",
};

describe.skipIf(!url)("incident numbers, write-ups and update visibility", () => {
  const app = createApp(openDatabase);
  const sent: { to: string; subject: string; html: string; text: string }[] = [];
  beforeAll(() => setMailTransport(async (m) => void sent.push(m)));
  afterAll(() => setMailTransport(undefined));

  const raw = (path: string, init: RequestInit = {}) => app.fetch(new Request(`${ORIGIN}${path}`, init), env as never);
  async function signedIn() {
    await raw("/internal/migrate", { method: "POST", headers: { "x-cron-secret": "cron" } });
    const su = await raw("/api/auth/sign-up/email", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: `inc-${Date.now()}-${Math.random().toString(36).slice(2, 6)}@example.com`, password: "correct horse battery", name: "Ada" }),
    });
    const cookie = su.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
    return async (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) => {
      const r = await raw(`/api${path}`, { method, headers: { cookie, "content-type": "application/json", ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
      return { status: r.status, body: (await r.json().catch(() => null)) as any };
    };
  }
  const pub = async (path: string) => (await raw(`/api/public/status/${path}`)).text();

  it("numbers incidents per project, also when they are created at the same time", async () => {
    const call = await signedIn();
    const hb = (await call("POST", "/monitors", { name: "Cron", type: "heartbeat", intervalSec: 3600 })).body;
    const first = await call("POST", "/incidents", { title: "First", monitorId: hb.id });
    const second = await call("POST", "/incidents", { title: "Payments down" });
    expect([first.body.number, second.body.number]).toEqual([1, 2]);

    const burst = await Promise.all(Array.from({ length: 10 }, (_, k) => call("POST", "/incidents", { title: `Burst ${k}`, monitorId: k % 2 ? hb.id : null })));
    expect(burst.every((r) => r.status === 201)).toBe(true);
    expect(burst.map((r) => r.body.number).sort((a, b) => a - b)).toEqual(Array.from({ length: 10 }, (_, k) => k + 3));

    // another project counts on its own
    const other = (await call("POST", "/projects", { name: "Other" })).body;
    const there = await call("POST", "/incidents", { title: "Elsewhere" }, { "x-project-id": other.id });
    expect(there.body.number).toBe(1);
    expect((await call("POST", "/incidents", { title: "Again" }, { "x-project-id": other.id })).body.number).toBe(2);
    expect((await call("POST", "/incidents", { title: "Back home" })).body.number).toBe(13);

    // list/detail carry the number; ?q= finds by INC-n, bare number or title
    expect((await call("GET", `/incidents/${second.body.id}`)).body.number).toBe(2);
    expect((await call("GET", "/incidents?q=INC-2")).body.map((i: any) => i.title)).toEqual(["Payments down"]);
    expect((await call("GET", "/incidents?q=payments")).body).toHaveLength(1);
  });

  it("edits root cause and postmortem with limits", async () => {
    const call = await signedIn();
    const inc = (await call("POST", "/incidents", { title: "DB failover" })).body;
    expect(inc.rootCause).toBeNull();
    const ok = await call("PATCH", `/incidents/${inc.id}`, { rootCause: "Primary ran out of disk", postmortem: "## Timeline\nWe added disk." });
    expect(ok.body).toMatchObject({ rootCause: "Primary ran out of disk", postmortem: "## Timeline\nWe added disk." });
    // a field left out stays; an empty one clears
    expect((await call("PATCH", `/incidents/${inc.id}`, { rootCause: "" })).body).toMatchObject({ rootCause: null, postmortem: "## Timeline\nWe added disk." });
    expect((await call("PATCH", `/incidents/${inc.id}`, { rootCause: "x".repeat(501) })).status).toBe(400);
    expect((await call("PATCH", `/incidents/${inc.id}`, { postmortem: "x".repeat(20001) })).status).toBe(400);
    expect((await call("PATCH", "/incidents/00000000-0000-4000-8000-000000000000", { rootCause: "x" })).status).toBe(404);
  });

  it("never shows internal updates, nor the write-up of an open incident, to the public", async () => {
    const call = await signedIn();
    const hb = (await call("POST", "/monitors", { name: "Cron", type: "heartbeat", intervalSec: 3600 })).body;
    const slug = `i${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
    expect((await call("POST", "/status-pages", { slug, title: "Acme", monitorIds: [hb.id] })).status).toBe(201);

    // a confirmed subscriber
    sent.length = 0;
    await raw(`/api/public/status/${slug}/subscribe`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: "reader@example.com" }) });
    const token = /token=([a-f0-9]+)/.exec(sent[0].html)![1];
    await raw(`/api/public/status/_/confirm?token=${token}`);

    const inc = (await call("POST", "/incidents", { title: "Checkout slow", monitorId: hb.id, body: "We are looking into it." })).body;
    await call("PATCH", `/incidents/${inc.id}`, { rootCause: "SECRET-ROOT-CAUSE", postmortem: "SECRET-POSTMORTEM" });
    sent.length = 0;
    const internal = await call("POST", `/incidents/${inc.id}/updates`, { status: "identified", body: "SECRET-INTERNAL-NOTE", visibility: "internal" });
    expect(internal.body.visibility).toBe("internal");
    expect(sent).toHaveLength(0);
    const shared = await call("POST", `/incidents/${inc.id}/updates`, { status: "monitoring", body: "A fix is rolling out.", visibility: "public" });
    expect(shared.body.visibility).toBe("public");
    expect(sent.map((m) => m.to)).toEqual(["reader@example.com"]);
    expect(sent[0].html + sent[0].text).not.toContain("SECRET");

    // open: the board, history and feed carry the public update only, and no write-up
    for (const path of [slug, `${slug}/incidents`, `${slug}/rss`]) {
      const text = await pub(path);
      expect(text).toContain("A fix is rolling out.");
      expect(text).not.toContain("SECRET");
    }
    const board = JSON.parse(await pub(slug));
    expect(board.incidents[0]).toMatchObject({ number: 1 });
    expect(board.incidents[0]).not.toHaveProperty("rootCause");

    // the team still sees everything
    const detail = (await call("GET", `/incidents/${inc.id}`)).body;
    expect(detail.updates.map((u: any) => [u.body, u.visibility])).toContainEqual(["SECRET-INTERNAL-NOTE", "internal"]);

    // a resolution cannot be kept internal: subscribers are mailed about it
    expect((await call("POST", `/incidents/${inc.id}/updates`, { status: "resolved", body: "Resolved.", visibility: "internal" })).status).toBe(400);
    expect((await call("GET", `/incidents/${inc.id}`)).body.resolvedAt).toBeNull();

    // resolved but not published: the write-up stays private
    expect((await call("POST", `/incidents/${inc.id}/updates`, { status: "resolved", body: "Resolved." })).status).toBe(201);
    for (const path of [slug, `${slug}/incidents`, `${slug}/rss`]) expect(await pub(path)).not.toContain("SECRET-ROOT-CAUSE");
    expect(await pub(`${slug}/incidents`)).not.toContain("SECRET-POSTMORTEM");

    // published by a person: root cause and postmortem go public, internal notes still do not
    expect((await call("PATCH", `/incidents/${inc.id}`, { publishPostmortem: true })).body.postmortemPublishedAt).toBeTruthy();
    const history = JSON.parse(await pub(`${slug}/incidents`));
    expect(history.items[0]).toMatchObject({ number: 1, rootCause: "SECRET-ROOT-CAUSE", postmortem: "SECRET-POSTMORTEM" });
    expect(JSON.stringify(history)).not.toContain("SECRET-INTERNAL-NOTE");
    expect(await pub(`${slug}/rss`)).not.toContain("SECRET-INTERNAL-NOTE");
    expect(await pub(slug)).not.toContain("SECRET-INTERNAL-NOTE");

    // and can be taken back
    expect((await call("PATCH", `/incidents/${inc.id}`, { publishPostmortem: false })).body.postmortemPublishedAt).toBeNull();
    expect(await pub(`${slug}/incidents`)).not.toContain("SECRET-POSTMORTEM");
  });

  it("keeps a manual incident (no monitor) on the status pages of its own project", async () => {
    const call = await signedIn();
    const other = (await call("POST", "/projects", { name: "Other" })).body;
    const tag = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;
    const slugA = `pa${tag}`;
    const slugB = `pb${tag}`;
    expect((await call("POST", "/status-pages", { slug: slugA, title: "Page A" })).status).toBe(201);
    expect((await call("POST", "/status-pages", { slug: slugB, title: "Page B" }, { "x-project-id": other.id })).status).toBe(201);
    for (const [slug, email] of [[slugA, "a@example.com"], [slugB, "b@example.com"]]) {
      sent.length = 0;
      await raw(`/api/public/status/${slug}/subscribe`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email }) });
      await raw(`/api/public/status/_/confirm?token=${/token=([a-f0-9]+)/.exec(sent[0].html)![1]}`);
    }

    const inc = (await call("POST", "/incidents", { title: "ONLY-IN-A", body: "Looking into it." })).body;
    sent.length = 0;
    await call("POST", `/incidents/${inc.id}/updates`, { status: "identified", body: "Found it." });
    expect(sent.map((m) => m.to)).toEqual(["a@example.com"]);

    for (const path of [slugA, `${slugA}/incidents`, `${slugA}/rss`, `${slugA}/llms.txt`]) expect(await pub(path)).toContain("ONLY-IN-A");
    for (const path of [slugB, `${slugB}/incidents`, `${slugB}/rss`, `${slugB}/llms.txt`]) expect(await pub(path)).not.toContain("ONLY-IN-A");
  });

  it("keeps the first update private when an incident is declared as internal", async () => {
    const call = await signedIn();
    const hb = (await call("POST", "/monitors", { name: "Cron", type: "heartbeat", intervalSec: 3600 })).body;
    const slug = `j${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
    await call("POST", "/status-pages", { slug, title: "Acme", monitorIds: [hb.id] });
    await call("POST", "/incidents", { title: "Quiet one", monitorId: hb.id, body: "SECRET-FIRST", visibility: "internal" });
    expect(await pub(slug)).not.toContain("SECRET-FIRST");
    expect(await pub(`${slug}/incidents`)).not.toContain("SECRET-FIRST");
  });
});
