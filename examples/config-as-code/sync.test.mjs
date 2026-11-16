// Runs with `node --test`; no network and no account: a small in-memory API stands in for OpenUptime.
import { test } from "node:test";
import assert from "node:assert/strict";
import { apply, client, describe, diffMonitor, plan, readConfig } from "./sync.mjs";

/** An in-memory stand-in for the endpoints the sync calls, with the same response shapes. */
function fakeApi({ monitors = [], channels = [] } = {}) {
  let next = 1;
  const calls = [];
  const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  const fetch = async (url, init) => {
    const path = new URL(url).pathname.replace(/^\/api/, "");
    const body = init.body ? JSON.parse(init.body) : undefined;
    calls.push(`${init.method} ${path}`);
    if (init.headers["x-api-key"] !== "key") return json(401, { error: "Unauthorized" });
    if (init.method === "GET" && path === "/monitors") return json(200, monitors);
    if (init.method === "GET" && path === "/channels") return json(200, channels);
    if (init.method === "POST" && path.startsWith("/monitors/import")) {
      const preview = path.endsWith("/preview");
      const report = body.monitors.map((m, index) => {
        if (m.target?.includes("127.0.0.1")) return { index, status: "skipped", error: "Private addresses are not allowed" };
        if (preview) return { index, status: "ready" };
        const { sourceId, ...fields } = m;
        const row = { id: `m${next++}`, paused: false, channelIds: [], ...fields, importSource: body.source, importSourceId: sourceId };
        monitors.push(row);
        return { index, status: "created", monitorId: row.id };
      });
      return json(preview ? 200 : 201, { report });
    }
    const id = path.split("/")[2];
    const at = monitors.findIndex((m) => m.id === id);
    if (init.method === "PATCH" && at >= 0) { Object.assign(monitors[at], body); return json(200, monitors[at]); }
    if (init.method === "DELETE" && at >= 0) { monitors.splice(at, 1); return json(200, { ok: true }); }
    return json(404, { error: "Not found" });
  };
  return { api: client({ baseUrl: "http://fake", apiKey: "key", fetch }), monitors, calls };
}

const config = (monitors) => readConfig({ source: "config:test", monitors });

test("fills ${NAME} from the environment and refuses an unset one", () => {
  const c = readConfig({ source: "s", monitors: [{ key: "a", name: "A", type: "http", target: "https://x.test", headers: { Authorization: "Bearer ${TOKEN}" } }] }, { TOKEN: "abc" });
  assert.equal(c.monitors[0].headers.Authorization, "Bearer abc");
  assert.throws(() => readConfig({ source: "s", monitors: [{ key: "a", name: "A", type: "http", target: "${URL}" }] }, {}), /URL is not set/);
});

test("refuses a malformed file", () => {
  assert.throws(() => readConfig({ monitors: [] }), /source/);
  assert.throws(() => readConfig({ source: "s", monitors: [{ key: "A B", name: "x", type: "http" }] }), /key/);
  assert.throws(() => readConfig({ source: "s", monitors: [{ key: "a", name: "x", type: "http" }, { key: "a", name: "y", type: "http" }] }), /twice/);
});

test("compares only the fields the file sets, whatever their key order", () => {
  const current = { key: "a", type: "http", name: "A", jsonAssertions: [{ path: "x", op: "equals", value: 1 }], extra: "kept", paused: false };
  assert.deepEqual(diffMonitor({ key: "a", type: "http", name: "A", jsonAssertions: [{ value: 1, op: "equals", path: "x" }] }, current), {});
  assert.deepEqual(diffMonitor({ key: "a", type: "http", name: "B", paused: true }, current), { name: { from: "A", to: "B" }, paused: { from: false, to: true } });
  assert.throws(() => diffMonitor({ key: "a", type: "http", headers: { A: "b" } }, { headers: { A: "••••••••" } }), /owner or admin/);
});

test("creates, then has nothing to do; prunes only when asked", async () => {
  const { api, monitors } = fakeApi({ monitors: [{ id: "hand", name: "Made in the app", type: "http", importSource: null }], channels: [{ id: "c1", name: "Ops" }] });
  const file = config([
    { key: "site", name: "Site", type: "http", target: "https://example.com", intervalSec: 60, channels: ["Ops"] },
    { key: "job", name: "Job", type: "heartbeat", paused: true },
  ]);
  const first = await plan(file, api);
  assert.deepEqual(first.create.map((c) => c.key), ["site", "job"]);
  await apply(file, api, first);
  assert.deepEqual(monitors.find((m) => m.importSourceId === "site").channelIds, ["c1"]);
  assert.equal(monitors.find((m) => m.importSourceId === "job").paused, true);

  const second = await plan(file, api);
  assert.equal(second.create.length + second.update.length + second.remove.length, 0);
  assert.match(describe(second), /No changes\. 2 monitors match/);

  const smaller = config([{ key: "site", name: "Site", type: "http", target: "https://example.com", intervalSec: 30, channels: ["Ops"] }]);
  const kept = await plan(smaller, api);
  assert.deepEqual(kept.update.map((u) => Object.keys(u.changes)), [["intervalSec"]]);
  assert.deepEqual(kept.kept.map((k) => k.key), ["job"]);
  const pruned = await plan(smaller, api, { prune: true });
  await apply(smaller, api, pruned);
  assert.deepEqual(monitors.map((m) => m.id).sort(), ["hand", "m1"]);
});

test("stops before changing anything when the plan has problems", async () => {
  const { api, calls } = fakeApi();
  const file = config([
    { key: "local", name: "Local", type: "http", target: "http://127.0.0.1" },
    { key: "alerts", name: "Alerts", type: "http", target: "https://example.com", channels: ["Missing"] },
  ]);
  const steps = await plan(file, api);
  assert.deepEqual(steps.problems.map((p) => p.key).sort(), ["alerts", "local"]);
  await assert.rejects(apply(file, api, steps), /problems/);
  assert.ok(calls.every((c) => c.startsWith("GET") || c.endsWith("/preview")));
});

test("refuses to change a monitor's type", async () => {
  const { api } = fakeApi({ monitors: [{ id: "x", type: "http", name: "A", importSource: "config:test", importSourceId: "a" }] });
  const steps = await plan(config([{ key: "a", name: "A", type: "tcp", target: "example.com:443" }]), api);
  assert.match(steps.problems[0].error, /new key/);
});

test("does not print header values or request bodies", () => {
  const text = describe({ create: [], update: [{ key: "a", changes: { headers: { from: { Authorization: "old" }, to: { Authorization: "Bearer new-secret" } }, requestBody: { from: null, to: "password=x" } } }], remove: [], unchanged: [], problems: [] });
  assert.doesNotMatch(text, /new-secret|password=x|old/);
});
