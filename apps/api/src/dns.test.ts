import { afterEach, describe, expect, it, vi } from "vitest";
import { dnsCheck } from "./dns";
import { runCheck, type CheckInput } from "./checker";
import { monitorCreateSchema, monitorPatchSchema } from "./routes/monitors";

vi.mock("./selfcheck", () => ({ networkLevelError: () => false, proberOnline: async () => true, proberSideError: () => false }));
const input: CheckInput = { type: "dns", target: "example.com", method: "GET", expectedStatus: 200, timeoutMs: 1000 };
const answer = (type: number, data: string, owner = "example.com.") => ({ name: owner, type, data });
function reply(Answer: unknown[] = [], Status = 0) {
  const f = vi.fn().mockResolvedValue(Response.json({ Status, Answer }));
  vi.stubGlobal("fetch", f);
  return f;
}
afterEach(() => vi.unstubAllGlobals());

describe("DNS record assertions", () => {
  it.each([["A", 1, "192.0.2.1"], ["AAAA", 28, "2001:db8::1"], ["CNAME", 5, "edge.example.net."], ["MX", 15, "10 mail.example.com."], ["TXT", 16, '"v=spf1 -all"'], ["NS", 2, "ns.example.net."]] as const)("queries and matches %s", async (type, code, value) => {
    const f = reply([answer(code, value)]);
    expect(await dnsCheck({ ...input, dnsRecordType: type, dnsExpectedValue: value }, Date.now())).toMatchObject({ ok: true });
    expect(f.mock.calls[0][0]).toContain(`&type=${type}`);
  });
  it("defaults to A and rejects CNAME-only, empty and unrelated answers", async () => {
    for (const values of [[], [answer(5, "edge.example.net.")], [answer(1, "192.0.2.1", "unrelated.example.")]]) {
      reply(values);
      expect(await dnsCheck(input, Date.now())).toMatchObject({ ok: false, error: "DNS no A records" });
    }
  });
  it("accepts a record reached through a CNAME chain regardless of answer order", async () => {
    reply([answer(1, "192.0.2.1", "edge.example.net."), answer(5, "edge.example.net.")]);
    expect(await dnsCheck(input, Date.now())).toMatchObject({ ok: true });
  });
  it("matches any selected answer and canonicalizes domain names, MX and IPv6", async () => {
    for (const [type, code, value, expected] of [["A", 1, "192.0.2.1", " 192.000.002.01 "], ["NS", 2, "NS.EXAMPLE.COM.", "ns.example.com"], ["MX", 15, "10 MAIL.EXAMPLE.COM.", "10 mail.example.com"], ["MX", 15, "10 mail.xn--bcher-kva.de.", "10 mail.bücher.de"], ["AAAA", 28, "2001:db8::1", "2001:0db8:0:0:0:0:0:1"]] as const) {
      reply([answer(code, "other"), answer(code, value)]);
      expect(await dnsCheck({ ...input, dnsRecordType: type, dnsExpectedValue: expected }, Date.now())).toMatchObject({ ok: true });
    }
  });
  it("normalizes Unicode targets and CNAME owners with IDNA", async () => {
    const f = reply([answer(5, "edge.xn--bcher-kva.de.", "xn--bcher-kva.de."), answer(1, "192.0.2.1", "edge.xn--bcher-kva.de.")]);
    expect(await dnsCheck({ ...input, target: " BÜCHER.de. ", dnsExpectedValue: "192.0.2.1" }, Date.now())).toMatchObject({ ok: true });
    expect(f.mock.calls[0][0]).toContain("name=xn--bcher-kva.de&type=A");
  });
  it("does not turn numeric-looking names into IPv4 addresses", async () => {
    for (const [target, query] of [["1.2.3", "name=1.2.3&"], ["0x7f.1", "name=0x7f.1&"], ["example.1", "name=example.1&"], ["Mail.Example.COM.", "name=mail.example.com&"]]) {
      const f = reply([answer(1, "192.0.2.1", query.slice(5, -1))]);
      expect(await dnsCheck({ ...input, target }, Date.now())).toMatchObject({ ok: true });
      expect(f.mock.calls[0][0]).toContain(query);
    }
  });
  it("queries underscore, wildcard and root names as written", async () => {
    for (const target of ["_dmarc.example.com", "_sip._tcp.example.com", "*.example.com", "a_b.example.com"]) {
      const f = reply([answer(16, '"v=DMARC1; p=none"', `${target}.`)]);
      expect(await dnsCheck({ ...input, target, dnsRecordType: "TXT", dnsExpectedValue: "DMARC1", dnsMatchMode: "contains" }, Date.now())).toMatchObject({ ok: true });
      expect(f.mock.calls[0][0]).toContain(`name=${encodeURIComponent(target)}&type=TXT`);
    }
    const f = reply([answer(2, "a.root-servers.net.", ".")]);
    await dnsCheck({ ...input, target: ".", dnsRecordType: "NS" }, Date.now());
    expect(f.mock.calls[0][0]).toContain("name=&type=NS");
  });
  it("trims the expected text in contains mode and ignores case except for TXT", async () => {
    for (const [type, code, value, expected, ok] of [["CNAME", 5, "Edge.Example.NET.", " edge.example ", true], ["NS", 2, "NS1.Example.Com.", "NS1.EXAMPLE", true], ["MX", 15, "10 Mail.Example.COM.", " mail.example.com", true], ["A", 1, "192.0.2.1", " 192.0.2 ", true], ["AAAA", 28, "2001:DB8::1", "2001:db8", true], ["TXT", 16, '"v=spf1 -all"', " spf1 ", true], ["TXT", 16, '"v=spf1 -all"', "SPF1", false]] as const) {
      reply([answer(code, value)]);
      expect(await dnsCheck({ ...input, dnsRecordType: type, dnsExpectedValue: expected, dnsMatchMode: "contains" }, Date.now())).toMatchObject({ ok });
    }
  });
  it("trims an AAAA expected value that is not a valid address", async () => {
    reply([answer(28, "not-an-address")]);
    expect(await dnsCheck({ ...input, dnsRecordType: "AAAA", dnsExpectedValue: "  not-an-address  " }, Date.now())).toMatchObject({ ok: true });
  });
  it("treats an answer past the 256 KB cap as an invalid response", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ Status: 0, Answer: [answer(1, "192.0.2.1")], Comment: "x".repeat(300_000) }))));
    expect(await dnsCheck(input, Date.now())).toMatchObject({ ok: false, error: "DNS resolver returned an invalid response" });
  });
  it("keeps TXT presentation and substring matching case-sensitive", async () => {
    for (const [expected, mode, ok] of [['"v=spf1 -all"', "exact", true], ["v=spf1 -all", "exact", false], ["spf1", "contains", true], ["SPF1", "contains", false]] as const) {
      reply([answer(16, '"v=spf1 -all"')]);
      expect(await dnsCheck({ ...input, dnsRecordType: "TXT", dnsExpectedValue: expected, dnsMatchMode: mode }, Date.now())).toMatchObject({ ok });
    }
  });
  it("does not let another record type satisfy a value assertion", async () => {
    reply([answer(5, "edge.example.net."), answer(1, "192.0.2.1", "edge.example.net.")]);
    expect(await dnsCheck({ ...input, dnsExpectedValue: "edge.example.net.", dnsMatchMode: "contains" }, Date.now())).toMatchObject({ ok: false, error: "DNS A answer did not contain the expected value" });
  });
  it("reports NXDOMAIN, SERVFAIL, invalid JSON, HTTP failures and truncation", async () => {
    for (const [response, error] of [[Response.json({ Status: 3 }), "NXDOMAIN"], [Response.json({ Status: 2 }), "status 2"], [Response.json({}), "invalid"], [new Response("not json"), "invalid"], [new Response("fail", { status: 503 }), "HTTP 503"], [Response.json({ Status: 0, TC: true }), "truncated"]] as const) {
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response));
      expect(await dnsCheck(input, Date.now())).toMatchObject({ ok: false, error: expect.stringContaining(error) });
    }
  });
  it("propagates timeout into a failed check", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new DOMException("DNS request timed out", "TimeoutError")));
    expect(await runCheck(input)).toMatchObject({ ok: false, error: expect.stringContaining("timed out") });
  });
  it("preserves response-body timeout errors", async () => {
    const response = new Response(new ReadableStream({ start(controller) { controller.error(new DOMException("DNS body timed out", "TimeoutError")); } }));
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response));
    expect(await runCheck(input)).toMatchObject({ ok: false, error: expect.stringContaining("timed out") });
  });
  it("shares validated defaults and patch fields with MCP", () => {
    expect(monitorCreateSchema.parse({ name: "dns", type: "dns", target: "example.com" })).toMatchObject({ dnsRecordType: "A", dnsExpectedValue: null, dnsMatchMode: "exact" });
    expect(monitorPatchSchema.parse({ dnsExpectedValue: "" })).toEqual({ dnsExpectedValue: null });
    expect(monitorPatchSchema.parse({ name: "rename" })).not.toHaveProperty("dnsRecordType");
    for (const bad of [{ dnsRecordType: "ANY" }, { dnsMatchMode: "regex" }, { dnsExpectedValue: "x".repeat(2001) }]) expect(monitorPatchSchema.safeParse(bad).success).toBe(false);
  });
});
