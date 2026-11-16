import type { CheckOutcome } from "./checker";
import { guardHosts, isWorkers, targetIsPrivate } from "./netguard";
import { proberOnline } from "@openuptime/kit/selfcheck";

/**
 * ICMP ping monitors. Node has no ICMP socket of its own, so the system `ping` command sends one echo request to a
 * validated address. Two failures are kept apart: the target not answering is a failed check, while a machine that
 * cannot run ping at all (no binary, no permission, a Cloudflare Worker) records nothing, so it never opens an outage.
 */

export const ICMP_PING_CAPABILITY = "icmp-ping-v1";

const LABEL = /^(?!-)[A-Za-z0-9-]{1,63}(?<!-)$/;
const IPV4 = /^(25[0-5]|2[0-4]\d|1?\d?\d)(\.(25[0-5]|2[0-4]\d|1?\d?\d)){3}$/;

/** The host a ping target names (a hostname, an IPv4 address or an IPv6 address, brackets allowed), or null. */
export function pingHost(target: string): string | null {
  const t = target.trim().replace(/^\[(.*)\]$/, "$1");
  if (!t || t.length > 253) return null;
  if (IPV4.test(t)) return t;
  if (t.includes(":")) {
    try { return new URL(`http://[${t}]/`).hostname.slice(1, -1) ? t.toLowerCase() : null; } catch { return null; }
  }
  const name = t.replace(/\.$/, "");
  return name.split(".").every((l) => LABEL.test(l)) && /[A-Za-z]/.test(name) ? name.toLowerCase() : null;
}

export const PING_TARGET_PROBLEM = "Enter a hostname or an IP address, without a scheme, port or path.";

/** Thrown when this machine cannot send a ping, as opposed to the target not answering one. */
export class PingUnavailable extends Error {
  constructor(message: string) { super(message); this.name = "PingUnavailable"; }
}

type Run = (cmd: string, args: string[], timeoutMs: number) => Promise<{ code: number | null; stdout: string; stderr: string; killed: boolean; missing: boolean }>;

const run: Run = async (cmd, args, timeoutMs) => {
  const { execFile } = await import("node:child_process");
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: timeoutMs, killSignal: "SIGKILL", maxBuffer: 64 * 1024, env: { PATH: process.env.PATH ?? "/usr/sbin:/usr/bin:/sbin:/bin", LC_ALL: "C" } }, (err, stdout, stderr) => {
      const e = err as (NodeJS.ErrnoException & { killed?: boolean; code?: number | string }) | null;
      resolve({
        code: e ? (typeof e.code === "number" ? e.code : null) : 0,
        stdout: String(stdout), stderr: String(stderr),
        killed: Boolean(e?.killed), missing: e?.code === "ENOENT" || e?.code === "EACCES",
      });
    });
  });
};
let runner: Run = run;
/** Tests replace the command runner to stand in for the platform's ping. */
export function setPingRunner(r: Run | null) { runner = r ?? run; available = undefined; }

/** The command and arguments for one echo request to `address`, waiting at most `seconds` for the reply. */
export function pingCommand(address: string, seconds: number, platform: string = process.platform): [string, string[]] {
  const v6 = address.includes(":");
  // macOS: -t is the overall timeout; its IPv6 ping is a separate command. Linux (iputils, BusyBox): -W waits for the reply.
  if (platform === "darwin") return v6 ? ["ping6", ["-c", "1", address]] : ["ping", ["-c", "1", "-t", String(seconds), address]];
  return ["ping", ["-c", "1", "-W", String(seconds), address]];
}

export type PingReading = { replied: true; rttMs: number | null } | { replied: false } | { unavailable: string };

/** What one run of ping says: a reply (with its round trip), no reply, or that ping itself could not run. */
export function readPing(r: Awaited<ReturnType<Run>>): PingReading {
  if (r.missing) return { unavailable: "the ping command is not installed" };
  const out = `${r.stdout}\n${r.stderr}`;
  const stats = /(\d+) packets transmitted, (\d+) (?:packets )?received/.exec(out);
  if (stats && Number(stats[1]) > 0) {
    if (Number(stats[2]) === 0) return { replied: false };
    const rtt = /time[=<]\s*([\d.]+)\s*ms/.exec(out);
    return { replied: true, rttMs: rtt ? Math.round(Number(rtt[1]) * 10) / 10 : null };
  }
  // it started sending but was stopped at the deadline before printing a summary
  if (r.killed && /^PING /m.test(r.stdout)) return { replied: false };
  const why = (r.stderr || r.stdout).split("\n").map((l) => l.trim()).find(Boolean) ?? `exit status ${r.code ?? "unknown"}`;
  return { unavailable: /permission|not permitted|operation not allowed|are you root/i.test(why) ? "this process is not allowed to send ICMP" : why.replace(/^ping6?:\s*/, "").slice(0, 160) };
}

let available: Promise<boolean> | undefined;
/** Whether this machine can send a ping: false on Workers, otherwise one echo request to the loopback address. */
export function pingAvailable(): Promise<boolean> {
  if (isWorkers() || typeof process === "undefined") return Promise.resolve(false);
  return (available ??= (async () => {
    try {
      const [cmd, args] = pingCommand("127.0.0.1", 1);
      const r = readPing(await runner(cmd, args, 3000));
      return "replied" in r && r.replied;
    } catch { return false; }
  })());
}

/**
 * One echo request to each validated address of the target in turn, within the monitor's timeout. The check passes on
 * the first reply; its latency is the round trip ping reports.
 */
export async function pingCheck(m: { target: string; timeoutMs: number }, started: number): Promise<CheckOutcome> {
  const host = pingHost(m.target);
  if (!host) return { ok: false, error: PING_TARGET_PROBLEM };
  if (isWorkers() || typeof process === "undefined") return unavailable("this location cannot send ICMP");
  const addresses = await guardHosts(host);
  const until = started + m.timeoutMs;
  for (const [i, address] of addresses.entries()) {
    const left = until - Date.now();
    if (left < 1000) break;
    // the time left is shared between the addresses still to try
    const slice = Math.max(1000, Math.floor(left / (addresses.length - i)));
    const seconds = Math.max(1, Math.floor(slice / 1000));
    const [cmd, args] = pingCommand(address, seconds);
    const reading = readPing(await runner(cmd, args, slice + 500));
    if ("unavailable" in reading) return unavailable(reading.unavailable);
    if (reading.replied) return { ok: true, latencyMs: reading.rttMs != null ? Math.max(0, Math.round(reading.rttMs)) : Date.now() - started };
  }
  const latencyMs = Date.now() - started;
  // no reply anywhere: unless the target is internal, make sure it is not this machine that lost its connection
  if (!(await targetIsPrivate(host)) && !(await proberOnline())) return { ok: false, inconclusive: true, error: "This location is offline" };
  const where = addresses.length === 1 && addresses[0] !== host ? `${host} (${addresses[0]})` : host;
  return { ok: false, latencyMs, error: `No reply to ping from ${where} within ${Math.round(m.timeoutMs / 1000)} s`, diagnosis: { kind: "timeout", timings: { totalMs: latencyMs } } };
}

/** The check could not be carried out here: nothing is recorded, and the reason says it is the checker, not the target. */
const unavailable = (why: string): CheckOutcome => ({ ok: false, inconclusive: true, error: `Ping could not run here: ${why}` });
