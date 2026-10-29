import { openDatabase } from "@openuptime/db-pg";
import { describe, expect, it, vi } from "vitest";

vi.mock("node:dns/promises", () => ({ lookup: async () => [{ address: "93.184.216.34", family: 4 }] }));
import { createApp } from "./app";

// Runs only when TEST_DATABASE_URL points at a database (shared with the other end-to-end tests).
const url = process.env.TEST_DATABASE_URL;
const ORIGIN = "http://localhost:8787";
const env = { DATABASE_URL: url, BETTER_AUTH_SECRET: "test-secret-test-secret-test-secret-123", BETTER_AUTH_URL: ORIGIN, WEB_ORIGIN: ORIGIN, CRON_SECRET: "cron" };

describe.skipIf(!url)("alert channels: auto-enable and in-use deletion", () => {
  const app = createApp(openDatabase);
  const raw = (path: string, init: RequestInit = {}) => app.fetch(new Request(`${ORIGIN}${path}`, init), env as never);

  it("adds auto-enable channels to new monitors and keeps used channels from being deleted", async () => {
    await raw("/internal/migrate", { method: "POST", headers: { "x-cron-secret": "cron" } });
    const su = await raw("/api/auth/sign-up/email", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: `chan-${Date.now()}@example.com`, password: "correct horse battery", name: "Ada" }),
    });
    expect(su.status).toBe(200);
    const cookie = su.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
    const call = async (method: string, path: string, body?: unknown, project?: string) => {
      const r = await raw(`/api${path}`, { method, headers: { cookie, "content-type": "application/json", ...(project ? { "x-project-id": project } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
      return { status: r.status, body: (await r.json().catch(() => null)) as any };
    };
    const discord = await call("POST", "/channels", { type: "discord", name: "Discord", config: { url: "https://discord.com/api/webhooks/123/test-token", ignored: "drop" } });
    expect(discord.status).toBe(201);
    expect(discord.body.config).toEqual({ url: "https://discord.com/api/webhooks/123/test-token" });
    expect((await call("GET", "/channels")).body).toContainEqual(expect.objectContaining({ id: discord.body.id, type: "discord" }));
    expect((await call("PATCH", `/channels/${discord.body.id}`, { config: { url: "https://discord.com/api/webhooks/123/replacement" } })).status).toBe(200);
    expect((await call("POST", "/channels", { type: "discord", name: "Missing", config: {} })).status).toBe(400);
    expect((await call("POST", "/channels", { type: "discord", name: "Private", config: { url: "http://127.0.0.1/hook" } })).status).toBe(400);
    expect((await call("DELETE", `/channels/${discord.body.id}`)).status).toBe(204);
    const teams = await call("POST", "/channels", { type: "teams", name: "Teams", config: { url: "https://example.com/api/webhooks/123/test-token", ignored: "drop" } });
    expect(teams.status).toBe(201);
    expect(teams.body.config).toEqual({ url: "https://example.com/api/webhooks/123/test-token" });
    expect((await call("GET", "/channels")).body).toContainEqual(expect.objectContaining({ id: teams.body.id, type: "teams" }));
    expect((await call("PATCH", `/channels/${teams.body.id}`, { config: { url: "https://example.com/api/webhooks/123/replacement" } })).status).toBe(200);
    expect((await call("POST", "/channels", { type: "teams", name: "Missing", config: {} })).status).toBe(400);
    expect((await call("POST", "/channels", { type: "teams", name: "Private", config: { url: "http://127.0.0.1/hook" } })).status).toBe(400);
    expect((await call("DELETE", `/channels/${teams.body.id}`)).status).toBe(204);
    const ntfy = await call("POST", "/channels", { type: "ntfy", name: "ntfy", config: { url: "https://ntfy.sh", topic: "ops", token: "test-token" } });
    expect(ntfy.status).toBe(201);
    expect(ntfy.body.config).toEqual({ url: "https://ntfy.sh", topic: "ops", token: "test-token", priority: "3" });
    expect((await call("GET", "/channels")).body).toContainEqual(expect.objectContaining({ id: ntfy.body.id, type: "ntfy" }));
    expect((await call("PATCH", `/channels/${ntfy.body.id}`, { config: { url: "https://ntfy.sh", topic: "ops", priority: "5" } })).status).toBe(200);
    for (const config of [{ url: "https://ntfy.sh", topic: "bad/topic" }, { url: "https://ntfy.sh", topic: "ops", priority: "6" }, { url: "http://127.0.0.1", topic: "ops" }, { url: "https://ntfy.sh/topic", topic: "ops" }]) {
      expect((await call("POST", "/channels", { type: "ntfy", name: "Invalid", config })).status).toBe(400);
    }
    // a token needs https and printable ASCII; an emptied token field removes it
    expect((await call("POST", "/channels", { type: "ntfy", name: "Plain", config: { url: "http://ntfy.example.com", topic: "ops", token: "t" } })).status).toBe(400);
    expect((await call("POST", "/channels", { type: "ntfy", name: "Accent", config: { url: "https://ntfy.sh", topic: "ops", token: "tökén" } })).status).toBe(400);
    const tokened = await call("POST", "/channels", { type: "ntfy", name: "Tokened", config: { url: "https://ntfy.sh", topic: "ops", token: "  secret  " } });
    expect(tokened.body.config.token).toBe("secret");
    const cleared = await call("PATCH", `/channels/${tokened.body.id}`, { config: { url: "https://ntfy.sh", topic: "ops", priority: "3", token: "" } });
    expect(cleared.status).toBe(200);
    expect(cleared.body.config).toEqual({ url: "https://ntfy.sh", topic: "ops", priority: "3" });
    expect((await call("DELETE", `/channels/${tokened.body.id}`)).status).toBe(204);
    expect((await call("DELETE", `/channels/${ntfy.body.id}`)).status).toBe(204);
    const monitor = { name: "Site", type: "http", target: "https://example.com" };

    const plain = (await call("POST", "/channels", { type: "email", name: "Plain", config: { to: "a@example.com" } })).body;
    const auto = (await call("POST", "/channels", { type: "email", name: "Auto", config: { to: "b@example.com" }, autoEnable: true })).body;
    expect(plain.autoEnable).toBe(false);
    expect(auto.autoEnable).toBe(true);

    // a new monitor starts out with the auto channel, also next to channels it was given explicitly
    const m1 = (await call("POST", "/monitors", monitor)).body;
    expect(m1.channelIds).toEqual([auto.id]);
    const m2 = (await call("POST", "/monitors", { ...monitor, name: "Two", channelIds: [plain.id] })).body;
    expect(new Set(m2.channelIds)).toEqual(new Set([plain.id, auto.id]));

    // channels are workspace-wide: another project sees the channel and its monitors start out with it as well
    const other = (await call("POST", "/projects", { name: "Second" })).body;
    expect(other.id).toBeTruthy();
    expect(((await call("GET", "/channels", undefined, other.id)).body as { id: string }[]).map((c) => c.id)).toContain(auto.id);
    const elsewhere = (await call("POST", "/monitors", { ...monitor, name: "Elsewhere" }, other.id)).body;
    expect(elsewhere.channelIds).toEqual([auto.id]);
    // a project-only channel stays in its project
    const own = (await call("POST", "/channels", { type: "email", name: "Own", config: { to: "c@example.com" }, scope: "project" })).body;
    expect(own.projectId).toBeTruthy();
    expect(((await call("GET", "/channels", undefined, other.id)).body as { id: string }[]).map((c) => c.id)).not.toContain(own.id);
    await call("DELETE", `/channels/${own.id}`);

    // imported monitors get it too
    const imp = await call("POST", "/monitors/import", [{ name: "Imported", type: "http", target: "https://example.org" }]);
    expect(imp.status).toBe(201);
    const listed = (await call("GET", "/monitors")).body as { name: string; channelIds: string[] }[];
    expect(listed.find((m) => m.name === "Imported")?.channelIds).toEqual([auto.id]);

    // a disabled auto channel is not added; turning auto-enable off stops it
    await call("PATCH", `/channels/${auto.id}`, { enabled: false });
    expect((await call("POST", "/monitors", { ...monitor, name: "Three" })).body.channelIds).toEqual([]);
    await call("PATCH", `/channels/${auto.id}`, { enabled: true, autoEnable: false });
    expect((await call("POST", "/monitors", { ...monitor, name: "Four" })).body.channelIds).toEqual([]);

    // used channels cannot be removed
    const blocked = await call("DELETE", `/channels/${auto.id}`);
    expect(blocked.status).toBe(409);
    expect(blocked.body.code).toBe("channel_in_use");
    // it counts the monitors of every project, including the other one
    expect(blocked.body.monitors.length).toBe(listed.filter((m) => m.channelIds.includes(auto.id)).length + 1);

    // once every monitor lets go of it, it goes
    for (const m of listed.filter((x) => x.channelIds.includes(auto.id))) {
      const id = ((await call("GET", "/monitors")).body as { id: string; name: string }[]).find((x) => x.name === m.name)!.id;
      await call("PATCH", `/monitors/${id}`, { channelIds: [] });
    }
    expect((await call("DELETE", `/channels/${auto.id}`)).status).toBe(409);
    await call("PATCH", `/monitors/${elsewhere.id}`, { channelIds: [] }, other.id);
    expect((await call("DELETE", `/channels/${auto.id}`)).status).toBe(204);
  });
});
