import { afterEach, describe, expect, it, vi } from "vitest";
import { runCheck } from "./checker";
import { configureNetGuard } from "./netguard";
import { configureProbes, resetProbeCapabilities, runInRegion } from "./probes";
import { pingAvailable, pingCommand, pingHost, readPing, setPingRunner } from "./ping";

type Ran = { code: number | null; stdout: string; stderr: string; killed: boolean; missing: boolean };
const ran = (o: Partial<Ran>): Ran => ({ code: 0, stdout: "", stderr: "", killed: false, missing: false, ...o });

const IPUTILS_REPLY = `PING 10.0.0.1 (10.0.0.1) 56(84) bytes of data.
64 bytes from 10.0.0.1: icmp_seq=1 ttl=64 time=12.3 ms

--- 10.0.0.1 ping statistics ---
1 packets transmitted, 1 received, 0% packet loss, time 0ms
rtt min/avg/max/mdev = 12.345/12.345/12.345/0.000 ms
`;
const BUSYBOX_LOST = `PING 10.0.0.1 (10.0.0.1): 56 data bytes

--- 10.0.0.1 ping statistics ---
1 packets transmitted, 0 packets received, 100% packet loss
`;
const MACOS_REPLY = `PING 10.0.0.1 (10.0.0.1): 56 data bytes
64 bytes from 10.0.0.1: icmp_seq=0 ttl=64 time=0.081 ms

--- 10.0.0.1 ping statistics ---
1 packets transmitted, 1 packets received, 0.0% packet loss
round-trip min/avg/max/stddev = 0.081/0.081/0.081/0.000 ms
`;

describe("ping targets", () => {
  it("accepts a hostname or an IP address and nothing else", () => {
    expect(pingHost("Example.COM")).toBe("example.com");
    expect(pingHost("example.com.")).toBe("example.com");
    expect(pingHost("10.0.0.1")).toBe("10.0.0.1");
    expect(pingHost("[2001:DB8::1]")).toBe("2001:db8::1");
    for (const bad of ["", "https://example.com", "example.com:443", "example.com/x", "-bad.example", "999.1.1.1", "1.2.3", "a b", "::zz"]) expect(pingHost(bad)).toBeNull();
  });

  it("builds the platform's command for one echo request", () => {
    expect(pingCommand("10.0.0.1", 5, "linux")).toEqual(["ping", ["-c", "1", "-W", "5", "10.0.0.1"]]);
    expect(pingCommand("2001:db8::1", 5, "linux")).toEqual(["ping", ["-c", "1", "-W", "5", "2001:db8::1"]]);
    expect(pingCommand("10.0.0.1", 5, "darwin")).toEqual(["ping", ["-c", "1", "-t", "5", "10.0.0.1"]]);
    expect(pingCommand("2001:db8::1", 5, "darwin")[0]).toBe("ping6");
  });
});

describe("reading ping's output", () => {
  it("tells a reply from no reply on iputils, BusyBox and macOS", () => {
    expect(readPing(ran({ stdout: IPUTILS_REPLY }))).toEqual({ replied: true, rttMs: 12.3 });
    expect(readPing(ran({ stdout: MACOS_REPLY }))).toEqual({ replied: true, rttMs: 0.1 });
    expect(readPing(ran({ code: 1, stdout: BUSYBOX_LOST }))).toEqual({ replied: false });
    // stopped at the deadline after it started sending
    expect(readPing(ran({ code: null, killed: true, stdout: "PING 10.0.0.1 (10.0.0.1): 56 data bytes\n" }))).toEqual({ replied: false });
  });

  it("says when ping itself could not run", () => {
    expect(readPing(ran({ code: null, missing: true }))).toEqual({ unavailable: "the ping command is not installed" });
    expect(readPing(ran({ code: 2, stderr: "ping: socket: Operation not permitted\n" }))).toEqual({ unavailable: "this process is not allowed to send ICMP" });
    expect(readPing(ran({ code: 1, stderr: "ping: bad address 'x'\n" }))).toEqual({ unavailable: "bad address 'x'" });
  });
});

describe("ping checks", () => {
  afterEach(() => { setPingRunner(null); configureNetGuard({}); });

  it("passes on a reply and reports the round trip as latency", async () => {
    configureNetGuard({ ALLOW_PRIVATE_TARGETS: "true" });
    const seen: string[][] = [];
    setPingRunner(async (cmd, args) => { seen.push([cmd, ...args]); return ran({ stdout: IPUTILS_REPLY }); });
    const r = await runCheck({ type: "ping" as const, method: "GET", expectedStatus: 200, target: "10.0.0.1", timeoutMs: 5000 });
    expect(r).toMatchObject({ ok: true, latencyMs: 12 });
    expect(seen[0].at(-1)).toBe("10.0.0.1");
  });

  it("fails as a timeout when nothing answers", async () => {
    configureNetGuard({ ALLOW_PRIVATE_TARGETS: "true" });
    setPingRunner(async () => ran({ code: 1, stdout: BUSYBOX_LOST }));
    const r = await runCheck({ type: "ping" as const, method: "GET", expectedStatus: 200, target: "10.0.0.1", timeoutMs: 2000 });
    expect(r).toMatchObject({ ok: false, error: "No reply to ping from 10.0.0.1 within 2 s", diagnosis: { kind: "timeout" } });
    expect(r.inconclusive).toBeFalsy();
  });

  it("records nothing when this machine cannot send ping", async () => {
    configureNetGuard({ ALLOW_PRIVATE_TARGETS: "true" });
    setPingRunner(async () => ran({ code: 2, stderr: "ping: socket: Operation not permitted" }));
    expect(await runCheck({ type: "ping" as const, method: "GET", expectedStatus: 200, target: "10.0.0.1", timeoutMs: 2000 })).toMatchObject({ ok: false, inconclusive: true, error: "Ping could not run here: this process is not allowed to send ICMP" });
    expect(await pingAvailable()).toBe(false);
  });

  it("refuses an internal target unless private targets are allowed", async () => {
    setPingRunner(async () => ran({ stdout: IPUTILS_REPLY }));
    const r = await runCheck({ type: "ping" as const, method: "GET", expectedStatus: 200, target: "10.0.0.1", timeoutMs: 2000 });
    expect(r.ok).toBe(false);
    expect(r.diagnosis?.kind).toBe("blocked");
  });
});

describe("ping from a probe region", () => {
  it("is only sent to probes that can ping", async () => {
    resetProbeCapabilities();
    configureProbes({ PROBE_REGIONS: '{"test":"https://probe.example.com/"}', PROBE_SECRET: "fixture" });
    const input = { type: "ping" as const, method: "GET", expectedStatus: 200, target: "example.com", timeoutMs: 2000 };
    const fetch = vi.fn(async (_url: unknown, _init?: RequestInit) => Response.json({ capabilities: ["http-request-body-v1", "api-flow-v1"] }));
    vi.stubGlobal("fetch", fetch);
    try {
      expect(await runInRegion("test", input)).toEqual({ region: "test", unreachable: "This probe cannot run ping checks" });
      fetch.mockImplementation(async (_url, init) => init?.method !== "POST" ? Response.json({ capabilities: ["icmp-ping-v1"] }) : Response.json({ ok: true, latencyMs: 9 }));
      expect(await runInRegion("test", input)).toMatchObject({ outcome: { ok: true, latencyMs: 9 } });
    } finally { vi.unstubAllGlobals(); configureProbes({}); resetProbeCapabilities(); }
  });

  it("says why a ping could not run at this location", async () => {
    setPingRunner(async () => ran({ code: null, missing: true }));
    try {
      configureNetGuard({ ALLOW_PRIVATE_TARGETS: "true" });
      expect(await runInRegion("auto", { type: "ping" as const, method: "GET", expectedStatus: 200, target: "10.0.0.1", timeoutMs: 2000 })).toEqual({ region: "auto", unreachable: "Ping could not run here: the ping command is not installed" });
    } finally { setPingRunner(null); configureNetGuard({}); }
  });
});
