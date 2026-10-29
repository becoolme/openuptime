import type { CheckInput, CheckOutcome } from "./checker";
import { readCapped } from "./netguard";

const TYPES = { A: 1, AAAA: 28, CNAME: 5, MX: 15, TXT: 16, NS: 2 } as const;
// WHATWG hostname parsing supplies IDNA in both Node and Workers, but it also applies IPv4 number parsing
// ("1.2.3" becomes "1.2.0.3", "0x7f.1" becomes "127.0.0.1"). So URL normalisation runs only for names with a
// non-ASCII character; an ASCII name (including DNS-only ones such as _dmarc, *.example.com and the root) is
// just lowercased and stripped of its trailing dot.
const name = (s: string) => {
  const raw = s.trim().toLowerCase().replace(/\.$/, "");
  if (!raw || !/[^\x00-\x7f]/.test(raw) || /[\s/:@?#\\]/.test(raw)) return raw;
  try { return new URL(`https://${raw}`).hostname; } catch { return raw; }
};

function exactValue(value: string, type: keyof typeof TYPES): string {
  if (type === "A") {
    const parts = value.trim().split(".");
    if (parts.length === 4 && parts.every((p) => /^\d{1,3}$/.test(p) && Number(p) <= 255)) return parts.map(Number).join(".");
    return value.trim();
  }
  if (type === "CNAME" || type === "NS") return name(value.trim());
  if (type === "MX") {
    const parts = /^(\d+)\s+(\S+)$/.exec(value.trim());
    return parts ? `${Number(parts[1])} ${name(parts[2])}` : value.trim();
  }
  if (type === "AAAA") {
    try { return new URL(`http://[${value.trim()}]/`).hostname; } catch { return value.trim(); }
  }
  return value;
}

type Answer = { name: string; type: number; data: string };
function isAnswer(v: unknown): v is Answer {
  if (!v || typeof v !== "object") return false;
  const a = v as Record<string, unknown>;
  return typeof a.name === "string" && typeof a.type === "number" && typeof a.data === "string";
}

/** Fixed public resolver: changing a record never causes a connection to the address it returns. */
export async function dnsCheck(m: CheckInput, started: number): Promise<CheckOutcome> {
  const type = m.dnsRecordType ?? "A";
  const done = (error?: string): CheckOutcome => ({ ok: !error, latencyMs: Date.now() - started, ...(error ? { error } : {}) });
  const url = `https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(name(m.target))}&type=${type}`;
  const res = await fetch(url, { headers: { accept: "application/dns-json" }, signal: AbortSignal.timeout(m.timeoutMs), redirect: "error" });
  if (!res.ok) {
    await res.body?.cancel();
    return done(`DNS resolver HTTP ${res.status}`);
  }
  const body = await readCapped(res, 262144);
  let raw: unknown;
  try { raw = JSON.parse(body); } catch { return done("DNS resolver returned an invalid response"); }
  if (!raw || typeof raw !== "object" || !("Status" in raw) || typeof raw.Status !== "number") return done("DNS resolver returned an invalid response");
  if (raw.Status !== 0) return done(raw.Status === 3 ? "DNS NXDOMAIN: name does not exist" : `DNS status ${raw.Status}`);
  if ("TC" in raw && raw.TC === true) return done("DNS resolver returned a truncated answer");
  const answers = "Answer" in raw && Array.isArray(raw.Answer) ? raw.Answer.filter(isAnswer) : [];
  // Accept only records belonging to the requested name or its CNAME chain, never unrelated answers.
  const owners = new Set([name(m.target)]);
  for (let i = 0; i < answers.length; i++) {
    let changed = false;
    for (const a of answers) if (a.type === TYPES.CNAME && owners.has(name(a.name)) && !owners.has(name(a.data))) { owners.add(name(a.data)); changed = true; }
    if (!changed) break;
  }
  const values = answers.filter((a) => a.type === TYPES[type] && owners.has(name(a.name))).map((a) => a.data);
  if (!values.length) return done(`DNS no ${type} records`);
  if (!m.dnsExpectedValue) return done();
  const contains = m.dnsMatchMode === "contains";
  // Substring matching trims the expected text; only TXT (free text) stays case-sensitive, names, MX and addresses do not.
  const expected = contains ? m.dnsExpectedValue.trim() : m.dnsExpectedValue;
  const fold = (v: string) => (type === "TXT" ? v : v.toLowerCase());
  const matched = values.some((value) => contains ? fold(value).includes(fold(expected)) : exactValue(value, type) === exactValue(expected, type));
  return done(matched ? undefined : `DNS ${type} answer did not ${m.dnsMatchMode === "contains" ? "contain" : "match"} the expected value`);
}
