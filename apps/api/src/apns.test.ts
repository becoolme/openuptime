import type { PushDevice } from "@openuptime/repo";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { apnsConfigured, buildPayload, buildProviderToken, configureApns, providerToken, sendPush, setApnsTransport, type ApnsRequest, type ApnsResponse } from "./apns";
import { deliver } from "./alerts";

let pem = "";
let publicKey: CryptoKey;
beforeAll(async () => {
  const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
  publicKey = pair.publicKey;
  const der = new Uint8Array(await crypto.subtle.exportKey("pkcs8", pair.privateKey));
  pem = `-----BEGIN PRIVATE KEY-----\n${btoa(String.fromCharCode(...der)).replace(/(.{64})/g, "$1\n")}\n-----END PRIVATE KEY-----\n`;
});

const env = () => ({ APNS_KEY: pem, APNS_KEY_ID: "KEYID12345", APNS_TEAM_ID: "TEAMID1234", APNS_BUNDLE_ID: "app.openuptime.ios" });
const TOKEN_A = "a".repeat(64);
const TOKEN_B = "b".repeat(64);
const device = (token: string, over: Partial<PushDevice> = {}): PushDevice => ({
  id: crypto.randomUUID(), userId: "u", token, platform: "ios", environment: "production", locale: null, name: null, createdAt: new Date(), lastSeenAt: new Date(), ...over,
});
const ev = { kind: "incident.opened" as const, incident: { id: "11111111-1111-1111-1111-111111111111", title: "API is down" }, monitor: { id: "m1", name: "API", target: "https://api.example.com" }, reason: "HTTP 503" };

const b64 = (s: string) => JSON.parse(atob(s.replace(/-/g, "+").replace(/_/g, "/")));

beforeEach(() => {
  configureApns(env());
});
afterEach(() => {
  setApnsTransport(null);
  configureApns({});
  vi.useRealTimers();
});

describe("configuration", () => {
  it("is configured only when all four values are set, and accepts literal \\n in the key", async () => {
    expect(apnsConfigured()).toBe(true);
    configureApns({ ...env(), APNS_TEAM_ID: "" });
    expect(apnsConfigured()).toBe(false);
    configureApns({ ...env(), APNS_KEY: pem.trim().replace(/\n/g, "\\n") });
    expect(apnsConfigured()).toBe(true);
    await expect(providerToken({ key: pem.trim().replace(/\n/g, "\\n").replace(/\\n/g, "\n"), keyId: "K", teamId: "T", bundleId: "b" })).resolves.toBeTruthy();
  });
});

describe("provider token", () => {
  it("is an ES256 JWT with kid and iss/iat that verifies against the public key", async () => {
    const jwt = await buildProviderToken({ key: pem, keyId: "KEYID12345", teamId: "TEAMID1234" }, 1_700_000_000);
    const [h, c, s] = jwt.split(".");
    expect(b64(h)).toEqual({ alg: "ES256", kid: "KEYID12345" });
    expect(b64(c)).toEqual({ iss: "TEAMID1234", iat: 1_700_000_000 });
    const sig = Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/")), (ch) => ch.charCodeAt(0));
    expect(sig).toHaveLength(64);
    expect(await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, publicKey, sig, new TextEncoder().encode(`${h}.${c}`))).toBe(true);
  });

  it("is reused for 50 minutes and then renewed", async () => {
    const cfg = { key: pem, keyId: "K", teamId: "T", bundleId: "b" };
    const t0 = 1_800_000_000_000;
    const first = await providerToken(cfg, t0);
    expect(await providerToken(cfg, t0 + 49 * 60_000)).toBe(first);
    const next = await providerToken(cfg, t0 + 51 * 60_000);
    expect(next).not.toBe(first);
    expect(b64(next.split(".")[1]).iat).toBe(Math.floor((t0 + 51 * 60_000) / 1000));
  });
});

describe("payload", () => {
  it("opened, in English", () => {
    const p = buildPayload(ev, "org1", "en");
    expect(p.aps.alert).toEqual({ title: "API is down", body: "HTTP 503" });
    expect(p.aps["interruption-level"]).toBe("time-sensitive");
    expect(p.aps["thread-id"]).toBe("m1");
    expect(p.aps.sound).toBe("default");
    expect(p).toMatchObject({ incidentId: ev.incident.id, monitorId: "m1", organizationId: "org1", kind: "incident.opened" });
  });
  it("opened, in Chinese, falls back to the target without a reason", () => {
    const p = buildPayload({ ...ev, reason: undefined }, "org1", "zh-CN");
    expect(p.aps.alert).toEqual({ title: "API 宕机了", body: "https://api.example.com" });
  });
  it("resolved carries the downtime and is not time-sensitive", () => {
    const startedAt = new Date("2026-01-01T00:00:00Z");
    const resolved = { ...ev, kind: "incident.resolved" as const, incident: { ...ev.incident, startedAt, resolvedAt: new Date(startedAt.getTime() + 75 * 60_000) } };
    expect(buildPayload(resolved, "o", "en").aps).toMatchObject({ alert: { title: "API has recovered", body: "Down for 1 h 15 min" }, "interruption-level": "active" });
    expect(buildPayload(resolved, "o", "zh-CN").aps.alert).toEqual({ title: "API 已恢复", body: "宕机时长 1小时 15分钟" });
  });
  it("test messages", () => {
    expect(buildPayload({ ...ev, test: true }, "o", "en").aps.alert).toEqual({ title: "Your channel is connected", body: "This is a test alert from OpenUptime" });
    expect(buildPayload({ ...ev, test: true }, "o", "zh-CN").aps.alert.title).toBe("渠道已连通");
  });
  it("clips long reasons far below 4 KB", () => {
    const p = buildPayload({ ...ev, reason: "x".repeat(10_000), monitor: { ...ev.monitor, name: "n".repeat(5000) } }, "o", "en");
    expect(JSON.stringify(p).length).toBeLessThan(1500);
  });
});

describe("sendPush", () => {
  const repoStub = () => {
    const removed: string[] = [];
    return { removed, repo: { deletePushDeviceByToken: async (t: string) => void removed.push(t) } };
  };
  const stub = (answer: (r: ApnsRequest) => ApnsResponse | Error) => {
    const seen: ApnsRequest[] = [];
    setApnsTransport(async (r) => {
      seen.push(r);
      const a = answer(r);
      if (a instanceof Error) throw a;
      return a;
    });
    return seen;
  };

  it("posts to the right host with the APNs headers", async () => {
    const seen = stub(() => ({ status: 200, body: "" }));
    const { repo } = repoStub();
    await sendPush(repo, [device(TOKEN_A), device(TOKEN_B, { environment: "sandbox", locale: "zh-CN" })], ev, "org1");
    const a = seen.find((r) => r.path.endsWith(TOKEN_A))!;
    const b = seen.find((r) => r.path.endsWith(TOKEN_B))!;
    expect(a.host).toBe("api.push.apple.com");
    expect(b.host).toBe("api.development.push.apple.com");
    expect(a.path).toBe(`/3/device/${TOKEN_A}`);
    expect(a.headers).toMatchObject({ "apns-topic": "app.openuptime.ios", "apns-push-type": "alert", "apns-priority": "10", "apns-collapse-id": ev.incident.id });
    expect(a.headers.authorization).toMatch(/^bearer [\w-]+\.[\w-]+\.[\w-]+$/);
    expect(Number(a.headers["apns-expiration"])).toBeGreaterThan(Date.now() / 1000);
    expect(JSON.parse(a.body).aps.alert.title).toBe("API is down");
    expect(JSON.parse(b.body).aps.alert.title).toBe("API 宕机了");
  });

  it("does nothing, without error, when there are no devices", async () => {
    const seen = stub(() => ({ status: 500, body: "" }));
    await sendPush(repoStub().repo, [], ev, "o");
    expect(seen).toHaveLength(0);
  });

  it("removes a device APNs says is gone", async () => {
    for (const res of [{ status: 410, body: "" }, { status: 400, body: JSON.stringify({ reason: "BadDeviceToken" }) }, { status: 400, body: JSON.stringify({ reason: "DeviceTokenNotForTopic" }) }, { status: 410, body: JSON.stringify({ reason: "Unregistered" }) }]) {
      stub(() => res);
      const { repo, removed } = repoStub();
      await sendPush(repo, [device(TOKEN_A)], ev, "o");
      expect(removed).toEqual([TOKEN_A]);
    }
  });

  it("throws only when every attempted device failed, and never names the token", async () => {
    stub(() => ({ status: 500, body: JSON.stringify({ reason: "InternalServerError" }) }));
    const { repo, removed } = repoStub();
    const err = await sendPush(repo, [device(TOKEN_A), device(TOKEN_B)], ev, "o").catch((e: Error) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toBe("APNs responded 500 (InternalServerError) (2 devices)");
    expect((err as Error).message).not.toContain(TOKEN_A);
    expect(removed).toEqual([]);

    // one succeeds: the alert counts as delivered
    stub((r) => (r.path.endsWith(TOKEN_A) ? { status: 200, body: "" } : { status: 429, body: JSON.stringify({ reason: "TooManyRequests" }) }));
    vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(sendPush(repo, [device(TOKEN_A), device(TOKEN_B)], ev, "o")).resolves.toBeUndefined();
    vi.restoreAllMocks();
  });

  it("does not leak the token or key from a network error", async () => {
    stub((r) => new Error(`connect ECONNRESET ${r.path} ${pem}`));
    const err = await sendPush(repoStub().repo, [device(TOKEN_A)], ev, "o").catch((e: Error) => e);
    expect((err as Error).message).toBe("Could not reach APNs");
  });

  it("a device that is gone does not make the alert fail", async () => {
    stub(() => ({ status: 410, body: "" }));
    await expect(sendPush(repoStub().repo, [device(TOKEN_A)], ev, "o")).resolves.toBeUndefined();
  });

  it("fails clearly when the server has no APNs configuration", async () => {
    configureApns({});
    await expect(sendPush(repoStub().repo, [device(TOKEN_A)], ev, "o")).rejects.toThrow(/not configured/);
  });

  it("is reachable through deliver() for a push channel", async () => {
    const seen = stub(() => ({ status: 200, body: "" }));
    const repo = { pushDevicesForOrganization: async (o: string) => (o === "org1" ? [device(TOKEN_A)] : []), deletePushDeviceByToken: async () => {} };
    await deliver({ type: "push", organizationId: "org1", config: {} }, ev, "text", "en", repo as never);
    expect(seen).toHaveLength(1);
    await expect(deliver({ type: "push", config: {} }, ev, "text", "en", repo as never)).rejects.toThrow();
  });
});
