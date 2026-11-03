import { openDatabase } from "@openuptime/db-pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "./app";
import { unmetered } from "./entitlements";

const url = process.env.TEST_DATABASE_URL;
const origin = "http://localhost:8787";
const env = { DATABASE_URL: url, BETTER_AUTH_SECRET: "bulk-test-secret-not-for-production", BETTER_AUTH_URL: origin, WEB_ORIGIN: origin };

describe.skipIf(!url)("bulk monitor actions", () => {
  const db = url ? openDatabase(url, { max: 3 }) : null;
  const app = createApp(openDatabase);
  beforeAll(async () => { await db!.migrate(); });
  afterAll(async () => { await db?.close(1); });
  async function account(use = app) {
    const signup = await use.fetch(new Request(origin + "/api/auth/sign-up/email", { method: "POST", headers: { origin, "content-type": "application/json" }, body: JSON.stringify({ email: `bulk-${crypto.randomUUID()}@example.com`, password: "correct horse battery", name: "Bulk" }) }), env as never);
    expect(signup.status).toBe(200);
    const cookie = signup.headers.getSetCookie().map((v) => v.split(";")[0]).join("; ");
    return async (method: string, path: string, body?: unknown) => {
      const res = await use.fetch(new Request(origin + "/api" + path, { method, headers: { origin, "content-type": "application/json", cookie }, body: body === undefined ? undefined : JSON.stringify(body) }), env as never);
      return { status: res.status, body: await res.json().catch(() => null) as any };
    };
  }
  const monitor = async (call: Awaited<ReturnType<typeof account>>, name: string) =>
    (await call("POST", "/monitors", { name, type: "http", target: "https://1.1.1.1/" + name })).body.id as string;

  it("pauses, resumes and deletes several monitors, reporting the ones it could not touch", async () => {
    const call = await account();
    const [a, b] = [await monitor(call, "a"), await monitor(call, "b")];
    const missing = crypto.randomUUID();
    const paused = await call("POST", "/monitors/bulk", { ids: [a, b, missing, a], action: "pause" });
    expect(paused.status).toBe(200);
    expect(paused.body).toEqual({ action: "pause", done: [a, b], failed: [{ id: missing, error: "Not found" }] });
    const list = (await call("GET", "/monitors")).body;
    expect(list.every((m: any) => m.paused && m.status === "paused")).toBe(true);
    expect((await call("POST", "/monitors/bulk", { ids: [a, b], action: "resume" })).body.done).toEqual([a, b]);
    expect((await call("GET", "/monitors")).body.every((m: any) => !m.paused && m.status === "pending")).toBe(true);
    expect((await call("POST", "/monitors/bulk", { ids: [a], action: "delete" })).body.done).toEqual([a]);
    expect((await call("GET", "/monitors")).body.map((m: any) => m.id)).toEqual([b]);
  });

  it("adds and removes alert channels without touching the others", async () => {
    const call = await account();
    const [a, b] = [await monitor(call, "a"), await monitor(call, "b")];
    const one = (await call("POST", "/channels", { type: "discord", name: "One", config: { url: "https://discord.com/api/webhooks/1/one" } })).body.id;
    const two = (await call("POST", "/channels", { type: "discord", name: "Two", config: { url: "https://discord.com/api/webhooks/2/two" } })).body.id;
    await call("PATCH", `/monitors/${a}`, { channelIds: [one] });
    expect((await call("POST", "/monitors/bulk", { ids: [a, b], action: "add_channels", channelIds: [two] })).body.done).toEqual([a, b]);
    const after = async (id: string) => ((await call("GET", `/monitors/${id}`)).body.channelIds as string[]).sort();
    expect(await after(a)).toEqual([one, two].sort());
    expect(await after(b)).toEqual([two]);
    await call("POST", "/monitors/bulk", { ids: [a, b], action: "remove_channels", channelIds: [two] });
    expect(await after(a)).toEqual([one]);
    expect(await after(b)).toEqual([]);
    expect((await call("POST", "/monitors/bulk", { ids: [a], action: "add_channels", channelIds: [crypto.randomUUID()] })).status).toBe(400);
    expect((await call("POST", "/monitors/bulk", { ids: [a], action: "add_channels" })).status).toBe(400);
  });

  it("never reaches another workspace's monitors", async () => {
    const mine = await account(), theirs = await account();
    const foreign = await monitor(theirs, "x");
    expect((await mine("POST", "/monitors/bulk", { ids: [foreign], action: "delete" })).body).toEqual({ action: "delete", done: [], failed: [{ id: foreign, error: "Not found" }] });
    expect((await theirs("GET", "/monitors")).body).toHaveLength(1);
  });

  it("refuses a resume that would go over the plan", async () => {
    const limited = createApp(openDatabase, { edition: { entitlements: () => ({ ...unmetered, plan: async () => ({ id: "one", name: "One", maxActiveMonitors: 1, minIntervalSec: 60, maxRegions: 1, upgradeUrl: "/upgrade" }) }) } });
    const call = await account(limited);
    const a = await monitor(call, "a");
    await call("POST", "/monitors/bulk", { ids: [a], action: "pause" });
    const b = await monitor(call, "b");
    expect(b).toEqual(expect.any(String));
    const res = await call("POST", "/monitors/bulk", { ids: [a], action: "resume" });
    expect(res.status).toBe(402);
    expect(res.body.code).toBe("monitor_limit");
  });
});
