import { openDatabase } from "@openuptime/db-pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "./app";
import { setPingRunner } from "./ping";

const url = process.env.TEST_DATABASE_URL;
const origin = "http://localhost:8787";
const env = { DATABASE_URL: url, BETTER_AUTH_SECRET: "ping-test-secret-not-for-production", BETTER_AUTH_URL: origin, WEB_ORIGIN: origin };

/** Stands in for the system ping: `false` is a machine that may not send ICMP, `true` one whose pings are answered. */
const pings = (can: boolean) => setPingRunner(async () => can
  ? { code: 0, stdout: "PING 1.1.1.1 (1.1.1.1): 56 data bytes\n64 bytes from 1.1.1.1: seq=0 ttl=57 time=4.2 ms\n\n1 packets transmitted, 1 packets received, 0% packet loss\n", stderr: "", killed: false, missing: false }
  : { code: 2, stdout: "", stderr: "ping: socket: Operation not permitted\n", killed: false, missing: false });

describe.skipIf(!url)("ping monitors", () => {
  const db = url ? openDatabase(url, { max: 3 }) : null;
  const app = createApp(openDatabase);
  beforeAll(async () => { await db!.migrate(); });
  afterAll(async () => { setPingRunner(null); await db?.close(1); });
  async function account() {
    const signup = await app.fetch(new Request(origin + "/api/auth/sign-up/email", { method: "POST", headers: { origin, "content-type": "application/json" }, body: JSON.stringify({ email: `ping-${crypto.randomUUID()}@example.com`, password: "correct horse battery", name: "Ping" }) }), env as never);
    expect(signup.status).toBe(200);
    const cookie = signup.headers.getSetCookie().map((v) => v.split(";")[0]).join("; ");
    return async (method: string, path: string, body?: unknown) => {
      const res = await app.fetch(new Request(origin + "/api" + path, { method, headers: { origin, "content-type": "application/json", cookie }, body: body === undefined ? undefined : JSON.stringify(body) }), env as never);
      return { status: res.status, body: await res.json().catch(() => null) as any };
    };
  }

  it("is offered and created only where this server can send ping", async () => {
    const call = await account();
    pings(false);
    expect((await call("GET", "/regions")).body.ping).toBe(false);
    const refused = await call("POST", "/monitors", { name: "Gateway", type: "ping", target: "1.1.1.1" });
    expect(refused).toMatchObject({ status: 400, body: { code: "ping_unavailable" } });
    pings(true);
    expect((await call("GET", "/regions")).body.ping).toBe(true);
    const created = await call("POST", "/monitors", { name: "Gateway", type: "ping", target: "1.1.1.1" });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({ type: "ping", target: "1.1.1.1", regions: ["auto"] });
  });

  it("refuses a target that is not a hostname or an IP address", async () => {
    const call = await account();
    pings(true);
    for (const target of ["https://1.1.1.1", "1.1.1.1:80", "1.1.1.1/x"]) {
      expect((await call("POST", "/monitors", { name: "Bad", type: "ping", target })).status).toBe(400);
    }
    const ok = await call("POST", "/monitors", { name: "Good", type: "ping", target: "1.1.1.1" });
    expect((await call("PATCH", `/monitors/${ok.body.id}`, { target: "https://1.1.1.1" })).status).toBe(400);
  });
});
