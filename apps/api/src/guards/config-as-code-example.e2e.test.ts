import { openDatabase } from "@openuptime/db-pg";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../app";

/**
 * The config-as-code example in examples/ talks to the public REST API. This runs it against the real app, so a change
 * to the monitor endpoints that breaks it fails here instead of in someone's CI.
 */

const url = process.env.TEST_DATABASE_URL;
const origin = "http://localhost:8787";
const env = { DATABASE_URL: url, BETTER_AUTH_SECRET: "config-as-code-test-secret-not-for-production", BETTER_AUTH_URL: origin, WEB_ORIGIN: origin };
const script = fileURLToPath(new URL("../../../../examples/config-as-code/sync.mjs", import.meta.url));

type Sync = {
  readConfig: (raw: unknown, env?: Record<string, string | undefined>) => any;
  client: (o: { baseUrl: string; apiKey: string; fetch: typeof fetch }) => any;
  plan: (config: any, api: any, o?: { prune?: boolean }) => Promise<any>;
  apply: (config: any, api: any, steps: any) => Promise<any>;
};

describe.skipIf(!url)("config-as-code example", () => {
  const db = url ? openDatabase(url, { max: 3 }) : null;
  const app = createApp(openDatabase);
  let sync: Sync;
  beforeAll(async () => { await db!.migrate(); sync = await import(/* @vite-ignore */ script); });
  afterAll(async () => { await db?.close(1); });

  async function account() {
    const signup = await app.fetch(new Request(origin + "/api/auth/sign-up/email", { method: "POST", headers: { origin, "content-type": "application/json" }, body: JSON.stringify({ email: `cac-${crypto.randomUUID()}@example.com`, password: "correct horse battery", name: "Config" }) }), env as never);
    expect(signup.status).toBe(200);
    const cookie = signup.headers.getSetCookie().map((v) => v.split(";")[0]).join("; ");
    // the script sends an API key; here the signed-up owner's session stands in for it
    const f = (async (input: string, init: RequestInit = {}) => {
      const headers = new Headers(init.headers);
      headers.delete("x-api-key");
      headers.set("cookie", cookie);
      headers.set("origin", origin);
      return app.fetch(new Request(input, { ...init, headers }), env as never);
    }) as unknown as typeof fetch;
    return { api: sync.client({ baseUrl: origin, apiKey: "session", fetch: f }), call: async (method: string, path: string, body?: unknown) => (await f(origin + "/api" + path, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) })).json() as Promise<any> };
  }

  const file = (extra: Record<string, unknown>[] = []) => ({
    source: "config:test",
    monitors: [
      { key: "api", name: "API", type: "http", target: "https://example.com/health", intervalSec: 300, tags: ["prod"], headers: { Authorization: "Bearer ${TEST_TOKEN}" }, channels: ["Ops"] },
      { key: "nightly-backup", name: "Nightly backup", type: "heartbeat", intervalSec: 86400, graceSec: 3600, paused: true },
      ...extra,
    ],
  });

  it("creates, then finds nothing to change, then updates and prunes", async () => {
    const { api, call } = await account();
    const ops = await call("POST", "/channels", { type: "discord", name: "Ops", config: { url: "https://discord.com/api/webhooks/123/test-token" } });
    const handMade = await call("POST", "/monitors", { name: "Made in the app", type: "heartbeat", intervalSec: 3600 });
    const vars = { TEST_TOKEN: "t0ken-from-ci" };

    let config = sync.readConfig(file(), vars);
    let steps = await sync.plan(config, api);
    expect(steps.problems).toEqual([]);
    expect(steps.create.map((c: any) => c.key)).toEqual(["api", "nightly-backup"]);
    await sync.apply(config, api, steps);

    const mine = (await call("GET", "/monitors")).filter((m: any) => m.importSource === "config:test");
    const apiMonitor = mine.find((m: any) => m.importSourceId === "api");
    expect(apiMonitor).toMatchObject({ name: "API", intervalSec: 300, channelIds: [ops.id], headers: { Authorization: "Bearer t0ken-from-ci" } });
    expect(mine.find((m: any) => m.importSourceId === "nightly-backup")).toMatchObject({ paused: true, graceSec: 3600 });

    // a second run of the same file has nothing to do
    steps = await sync.plan(config, api);
    expect({ create: steps.create, update: steps.update, problems: steps.problems }).toEqual({ create: [], update: [], problems: [] });
    expect(steps.unchanged).toHaveLength(2);

    // an edited file updates in place; a monitor left out is kept unless pruning
    const edited = file();
    edited.monitors[0] = { ...edited.monitors[0], intervalSec: 60 };
    edited.monitors.pop();
    config = sync.readConfig(edited, vars);
    steps = await sync.plan(config, api);
    expect(steps.update).toEqual([expect.objectContaining({ key: "api", changes: { intervalSec: { from: 300, to: 60 } } })]);
    expect(steps.remove).toEqual([]);
    expect(steps.kept.map((k: any) => k.key)).toEqual(["nightly-backup"]);
    steps = await sync.plan(config, api, { prune: true });
    expect(steps.remove.map((r: any) => r.key)).toEqual(["nightly-backup"]);
    await sync.apply(config, api, steps);
    expect((await sync.plan(config, api, { prune: true })).unchanged).toHaveLength(1);

    const left = await call("GET", "/monitors");
    expect(left.map((m: any) => m.name).sort()).toEqual(["API", "Made in the app"]);
    expect(left.find((m: any) => m.id === handMade.id)).toBeTruthy();
  });

  it("applies the sample file, and a second run finds nothing to change", async () => {
    const { api } = await account();
    const raw = JSON.parse(await readFile(fileURLToPath(new URL("../../../../examples/config-as-code/monitors.json", import.meta.url)), "utf8"));
    const config = sync.readConfig(raw, { HEALTH_TOKEN: "sample" });
    const first = await sync.plan(config, api);
    expect(first.problems).toEqual([]);
    await sync.apply(config, api, first);
    const again = await sync.plan(config, api);
    expect({ create: again.create, update: again.update, problems: again.problems }).toEqual({ create: [], update: [], problems: [] });
    expect(again.unchanged).toHaveLength(raw.monitors.length);
  });

  it("reports problems before changing anything", async () => {
    const { api, call } = await account();
    const config = sync.readConfig(file([{ key: "bad", name: "Bad", type: "http", target: "http://127.0.0.1/admin" }]), { TEST_TOKEN: "x" });
    const steps = await sync.plan(config, api);
    expect(steps.problems.map((p: any) => p.key).sort()).toEqual(["api", "bad"]);
    await expect(sync.apply(config, api, steps)).rejects.toThrow(/problems/);
    expect(await call("GET", "/monitors")).toEqual([]);
  });
});
