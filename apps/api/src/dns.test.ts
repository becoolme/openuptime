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
