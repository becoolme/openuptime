import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync } from "node:fs";
import { createInterface } from "node:readline";
import test from "node:test";

test("stdio evaluator uses the real authenticated API and cleans up", { timeout: 90_000 }, async (t) => {
  const child = spawn(process.execPath, [new URL("server.mjs", import.meta.url).pathname], {
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, DATABASE_URL: "postgres://never.invalid/production", DISABLE_SIGNUP: "true" },
  });
  let logs = "";
  child.stderr.on("data", (chunk) => { logs += chunk; });
  const exited = once(child, "exit");
  t.after(() => { if (child.exitCode === null) child.kill("SIGTERM"); });
  const pending = new Map();
  const lines = createInterface({ input: child.stdout });
  lines.on("line", (line) => {
    const message = JSON.parse(line); // Any startup log on stdout fails the test.
    pending.get(message.id)?.(message);
    pending.delete(message.id);
  });
  let id = 0;
  async function rpc(method, params) {
    const current = ++id;
    const answer = new Promise((done) => pending.set(current, done));
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: current, method, params }) + "\n");
    return Promise.race([
      answer,
      exited.then(() => { throw new Error(`Sandbox exited early: ${logs}`); }),
      new Promise((_, reject) => {
        const timer = setTimeout(() => reject(new Error(`RPC timeout: ${logs}`)), 60_000);
        timer.unref();
      }),
    ]);
  }
  async function tool(name, args = {}) {
    const response = await rpc("tools/call", { name, arguments: args });
    assert.equal(response.error, undefined, JSON.stringify(response));
    assert.notEqual(response.result.isError, true, JSON.stringify(response));
    const text = response.result.content[0].text;
    try { return JSON.parse(text); } catch { return text; }
  }
  const initialize = await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "sandbox-test", version: "1" } });
  assert.equal(initialize.result.serverInfo.name, "openuptime");
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
  const manifest = await rpc("tools/list", {});
  assert.ok(manifest.result.tools.some((item) => item.name === "create_monitor"));
  assert.ok(manifest.result.tools.some((item) => item.name === "status_page_overview"));
  const workspaces = await tool("list_workspaces");
  assert.equal(workspaces.workspaces.length, 1);
  assert.deepEqual(await tool("list_monitors"), []);
  const monitor = await tool("create_monitor", { name: "Sandbox heartbeat", type: "heartbeat", intervalSec: 3600 });
  assert.ok(monitor.id);
  await tool("update_monitor", { id: monitor.id, paused: true, name: "Updated in sandbox" });
  const monitors = await tool("list_monitors");
  assert.equal(monitors[0].name, "Updated in sandbox");
  assert.equal(monitors[0].paused, true);
  await tool("delete_monitor", { id: monitor.id });
  assert.deepEqual(await tool("list_monitors"), []);
  const invalid = await rpc("tools/call", { name: "create_monitor", arguments: { name: "" } });
  assert.equal(invalid.result.isError, true);
  const malformed = new Promise((done) => pending.set(null, done));
  child.stdin.write("not json\n");
  assert.equal((await malformed).error.code, -32700);
  assert.ok((await rpc("ping", {})).result);
  child.stdin.end();
  const [code] = await exited;
  assert.equal(code, 0, logs);
  assert.match(logs, /Glama sandbox ready/);
  assert.match(logs, /Glama sandbox removed/);
  const directory = logs.match(/Glama sandbox directory: (.+)/)?.[1];
  assert.ok(directory);
  assert.equal(existsSync(directory), false, "Temporary database files must be removed on EOF");
});
