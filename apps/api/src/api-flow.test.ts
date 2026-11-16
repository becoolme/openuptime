import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ApiFlow } from "@openuptime/repo";
import { apiFlowSchema, maskFlow, restoreFlow } from "./api-flow";
import { runCheck, type CheckInput } from "./checker";
import { sanitizeSteps } from "./diagnosis";
import { configureNetGuard } from "./netguard";
import { MASK } from "./secrets";

const TOKEN = "tok-abcdef123456";

describe("multi-step API checks", () => {
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://x");
    if (url.pathname === "/login") {
      res.writeHead(200, { "content-type": "application/json", "x-request-id": "req-4242" });
      return res.end(JSON.stringify({ data: { token: TOKEN, user: { id: 7 } } }));
    }
    if (url.pathname === "/items/7") {
      if (req.headers.authorization !== `Bearer ${TOKEN}`) { res.writeHead(401); return res.end("no"); }
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify({ items: [{ id: 1 }], ref: req.headers["x-ref"] ?? null }));
    }
    if (url.pathname === "/broken") {
      // echoes the token back, as a careless error page might
      res.writeHead(500, { "content-type": "text/plain" });
      return res.end(`upstream rejected ${req.headers.authorization}`);
    }
    if (url.pathname === "/slow") { setTimeout(() => { res.end("late"); }, 1500); return; }
    res.end("ok");
  });
  let base = "";
  beforeAll(async () => {
    configureNetGuard({ ALLOW_PRIVATE_TARGETS: "true" });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => { server.close(); configureNetGuard({}); });

  const flow = (steps: unknown[], extract: unknown[] = [{ name: "token", path: "$.data.token" }, { name: "uid", path: "$.data.user.id" }]) =>
    apiFlowSchema.parse({ extract, steps }) as ApiFlow;
  const check = (apiFlow: ApiFlow, over: Partial<CheckInput> = {}) =>
    runCheck({ type: "http", method: "POST", expectedStatus: 200, timeoutMs: 5000, target: `${base}/login`, apiFlow, ...over });

  it("passes values read from one answer to the next request", async () => {
    const r = await check(flow([{ name: "List items", url: `${base}/items/{{uid}}`, headers: { authorization: "Bearer {{token}}", "x-ref": "{{rid}}" }, jsonAssertions: [{ path: "$.items[0].id", op: "equals", value: "1" }] }],
      [{ name: "token", path: "$.data.token" }, { name: "uid", path: "$.data.user.id" }, { name: "rid", from: "header", path: "x-request-id" }]));
    expect(r.ok).toBe(true);
    expect(r.statusCode).toBe(200);
    expect(r.steps?.map((s) => [s.name, s.ok])).toEqual([["Request 1", true], ["List items", true]]);
  });

  it("fails on a value that is not in the answer, naming the step", async () => {
    const r = await check(flow([{ name: "List items", url: `${base}/items/{{uid}}` }], [{ name: "uid", path: "$.data.missing" }]));
    expect(r.ok).toBe(false);
    expect(r.error).toBe("Step 1 (Request 1): JSON $.data.missing is missing, so {{uid}} could not be read");
    expect(r.diagnosis?.kind).toBe("assertion");
    expect(r.diagnosis?.steps).toHaveLength(1);
  });

  it("fails at the first failing step and never shows a value it read", async () => {
    const r = await check(flow([
      { name: "List items", url: `${base}/items/{{uid}}`, headers: { authorization: "Bearer {{token}}" } },
      { name: "Broken", url: `${base}/broken`, headers: { authorization: "Bearer {{token}}" } },
      { name: "Never run", url: `${base}/` },
    ]));
    expect(r.ok).toBe(false);
    expect(r.statusCode).toBe(500);
    expect(r.error).toMatch(/^Step 3 \(Broken\): /);
    expect(r.diagnosis?.steps?.map((s) => s.ok)).toEqual([true, true, false]);
    expect(r.diagnosis?.body).toContain("upstream rejected");
    expect(JSON.stringify(r)).not.toContain(TOKEN);
  });

  it("shares the monitor's timeout across all requests", async () => {
    const started = Date.now();
    const r = await check(flow([{ name: "Slow", url: `${base}/slow` }, { name: "After", url: `${base}/` }], []), { timeoutMs: 1000 });
    expect(r.ok).toBe(false);
    expect(Date.now() - started).toBeLessThan(2500);
    expect(r.diagnosis?.kind).toBe("timeout");
  });

  it("refuses a step that uses a value never read, or a value in the host", () => {
    expect(apiFlowSchema.safeParse({ steps: [{ name: "a", url: "https://api.example.test/{{nope}}" }] }).success).toBe(false);
    expect(apiFlowSchema.safeParse({ extract: [{ name: "host", path: "$.h" }], steps: [{ name: "a", url: "https://{{host}}/x" }] }).success).toBe(false);
    expect(apiFlowSchema.safeParse({ extract: [{ name: "id", path: "$.id" }], steps: [{ name: "a", url: "https://api.example.test/u/{{id}}?q={{ id }}" }] }).success).toBe(true);
    expect(apiFlowSchema.safeParse({ extract: [{ name: "id", path: "$.id" }, { name: "id", path: "$.x" }], steps: [{ name: "a", url: "https://api.example.test/" }] }).success).toBe(false);
    expect(apiFlowSchema.safeParse({ steps: [{ name: "a", url: "https://api.example.test/", method: "GET", body: "x" }] }).success).toBe(false);
    expect(apiFlowSchema.safeParse({ steps: Array.from({ length: 6 }, (_, i) => ({ name: `s${i}`, url: "https://api.example.test/" })) }).success).toBe(false);
  });
});

describe("step secrets", () => {
  const stored = apiFlowSchema.parse({ steps: [{ name: "a", method: "POST", url: "https://api.example.test/", headers: { authorization: "Bearer real" }, body: '{"k":"v"}' }] }) as ApiFlow;
  it("masks header values and bodies, and puts the stored ones back for placeholders", () => {
    const masked = maskFlow(stored)!;
    expect(masked.steps[0].headers.authorization).toBe(MASK);
    expect(masked.steps[0].body).toBe(MASK);
    expect(JSON.stringify(masked)).not.toContain("real");
    expect(restoreFlow(masked, stored)).toEqual(stored);
    // a placeholder with nothing stored behind it is dropped
    expect(restoreFlow(masked, null)!.steps[0]).toMatchObject({ headers: {}, body: null });
  });
  it("cuts a probe's step lines to size", () => {
    expect(sanitizeSteps([{ name: "x".repeat(100), ok: true, ms: 3.7, statusCode: 200 }, "junk", { name: "b", ok: false, ms: -1, error: "password=hunter2" }])).toEqual([
      { name: "x".repeat(60), ok: true, ms: 4, statusCode: 200 },
      { name: "b", ok: false, ms: 0, error: "password=[redacted]" },
    ]);
    expect(sanitizeSteps("nope")).toBeUndefined();
  });
});
