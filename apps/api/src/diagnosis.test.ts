import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runCheck, type CheckInput } from "./checker";
import { bodyExcerpt, classifyError, keptHeaders, redactText, safeUrl, sanitizeDiagnosis, secretsOf } from "./diagnosis";
import { configureNetGuard } from "./netguard";

const withCause = (code: string, message = "fetch failed") => Object.assign(new TypeError(message), { cause: Object.assign(new Error(code), { code }) });

describe("failure kinds", () => {
  it("tells name lookup, connection, TLS and timeout failures apart", () => {
    expect(classifyError(withCause("ENOTFOUND"))).toBe("dns");
    expect(classifyError(withCause("EAI_AGAIN"))).toBe("dns");
    expect(classifyError(withCause("ECONNREFUSED"))).toBe("connect");
    expect(classifyError(withCause("ECONNRESET"))).toBe("connect");
    expect(classifyError(withCause("CERT_HAS_EXPIRED"))).toBe("tls");
    expect(classifyError(withCause("UNABLE_TO_VERIFY_LEAF_SIGNATURE"))).toBe("tls");
    expect(classifyError(withCause("ERR_TLS_CERT_ALTNAME_INVALID"))).toBe("tls");
    expect(classifyError(withCause("UND_ERR_CONNECT_TIMEOUT"))).toBe("timeout");
    expect(classifyError(Object.assign(new Error("The operation was aborted due to timeout"), { name: "TimeoutError" }))).toBe("timeout");
    expect(classifyError(Object.assign(new Error("Target not allowed"), { name: "BlockedTarget" }))).toBe("blocked");
    expect(classifyError(new Error("Too many redirects"))).toBe("other");
    expect(classifyError("nope")).toBe("other");
  });
});

describe("redaction", () => {
  it("removes the monitor's own header values and URL credentials, also when echoed in part", () => {
    const secrets = secretsOf("https://bob:hunter22@api.example.test/x?token=abcd1234&page=2", { authorization: "Bearer s3cr3t-value", cookie: "sid=cookie-value-1; theme=dark", "x-api-key": "key-0001" });
    const text = redactText("got s3cr3t-value and Bearer s3cr3t-value, cookie-value-1, key-0001, hunter22 and abcd1234", secrets);
    for (const s of ["s3cr3t-value", "cookie-value-1", "key-0001", "hunter22", "abcd1234"]) expect(text).not.toContain(s);
  });
  it("removes things shaped like credentials without being told", () => {
    const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjMifQ.c2lnbmF0dXJlLWJ5dGVz";
    const out = redactText(`{"password":"pw1","access_token":"t-1","user":"ann","statusCode":500} api_key=k-9 Authorization: Basic dXNlcjpwYXNz ${jwt} ann@example.com ${"a1".repeat(30)}`);
    for (const s of ["pw1", "t-1", "k-9", "dXNlcjpwYXNz", jwt, "ann@example.com", "a1a1a1a1a1a1a1a1a1a1a1a1"]) expect(out).not.toContain(s);
    // ordinary fields stay readable
    expect(out).toContain('"user":"ann"');
    expect(out).toContain('"statusCode":500');
  });
  it("turns an HTML error page into its text and caps the length", () => {
    const page = `<!doctype html><html><head><style>body{}</style><script>var key="x"</script><title>502</title></head><body><h1>Bad gateway</h1><p>Upstream &amp; origin unreachable</p></body></html>`;
    expect(bodyExcerpt(page)).toBe("502 Bad gateway Upstream & origin unreachable");
    expect(bodyExcerpt("x ".repeat(5000))!.length).toBeLessThanOrEqual(1001);
    expect(bodyExcerpt("   ")).toBeUndefined();
  });
  it("shows URLs without credentials or secret-looking query values", () => {
    expect(safeUrl("https://u:p@example.test/cb?code=abc&state=xyz&page=2&ref=" + "r".repeat(30) + "#frag")).toBe("https://example.test/cb?code=[redacted]&state=[redacted]&page=2&ref=[redacted]");
  });
  it("keeps only allowlisted headers and never Set-Cookie", () => {
    const h = new Headers({ server: "nginx", "set-cookie": "sid=1", "x-internal-token": "t", "www-authenticate": 'Bearer realm="x", error="invalid_token"', location: "/login?next=/a&ticket=abc", "content-type": "text/html" });
    expect(keptHeaders(h, "https://example.test/start")).toEqual({ server: "nginx", "content-type": "text/html", location: "https://example.test/login?next=%2Fa&ticket=[redacted]", "www-authenticate": "Bearer" });
  });
  it("checks a probe's diagnosis instead of trusting it", () => {
    expect(sanitizeDiagnosis({ kind: "rm -rf" })).toBeUndefined();
    expect(sanitizeDiagnosis(null)).toBeUndefined();
    const d = sanitizeDiagnosis({ kind: "http", timings: { totalMs: 12.4, firstByteMs: -1 }, headers: { server: "x", "set-cookie": "a=b" }, redirects: [{ url: "https://u:p@a.test/?token=1", status: 301, location: "https://b.test/", ms: 3 }, "junk"], body: "password=hunter2", extra: "dropped" });
    expect(d).toEqual({ kind: "http", timings: { totalMs: 12 }, headers: { server: "x" }, redirects: [{ url: "https://a.test/?token=[redacted]", status: 301, location: "https://b.test/", ms: 3 }], body: "password=[redacted]" });
  });
});

describe("diagnosis of a failed http check", () => {
  const server = createServer((req, res) => {
    if (req.url === "/a") { res.writeHead(302, { location: "/b?state=opaque-state" }); return res.end(); }
    if (req.url?.startsWith("/b?")) { res.writeHead(503, { "content-type": "text/html", server: "test", "set-cookie": "session=abc" }); return res.end(`<h1>Maintenance</h1><p>token ${req.headers["x-token"]}</p>`); }
    if (req.url === "/json") { res.writeHead(200, { "content-type": "application/json" }); return res.end('{"status":"degraded"}'); }
    res.end("ok");
  });
  let base = "";
  beforeAll(async () => {
    configureNetGuard({ ALLOW_PRIVATE_TARGETS: "true" });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => { server.close(); configureNetGuard({}); });
  const check = (over: Partial<CheckInput> & { path: string }) => runCheck({ type: "http", method: "GET", expectedStatus: 200, timeoutMs: 3000, ...over, target: base + over.path });

  it("records the redirect chain, the headers and the start of the body, without the request's token", async () => {
    const r = await check({ path: "/a", headers: { "x-token": "tok-secret-1" } });
    expect(r.ok).toBe(false);
    const d = r.diagnosis!;
    expect(d.kind).toBe("http");
    expect(d.redirects!.map((h) => h.status)).toEqual([302, 503]);
    expect(d.redirects![0].location).toBe(`${base}/b?state=[redacted]`);
    expect(d.headers).toEqual({ server: "test", "content-type": "text/html" });
    expect(d.body).toContain("Maintenance");
    expect(JSON.stringify(d)).not.toContain("tok-secret-1");
    expect(JSON.stringify(d)).not.toContain("session=abc");
    expect(d.timings!.totalMs).toBeGreaterThanOrEqual(d.timings!.firstByteMs!);
  });
  it("marks a content check that did not hold as an assertion failure", async () => {
    const r = await check({ path: "/json", jsonAssertions: [{ path: "$.status", op: "equals", value: "ok" }] });
    expect(r.diagnosis).toMatchObject({ kind: "assertion", body: '{"status":"degraded"}' });
    expect((await check({ path: "/", keyword: "missing" })).diagnosis?.kind).toBe("assertion");
  });
  it("marks a refused connection as a connection failure, and keeps nothing on success", async () => {
    const closed = createServer();
    await new Promise<void>((r) => closed.listen(0, "127.0.0.1", r));
    const port = (closed.address() as AddressInfo).port;
    await new Promise<void>((r) => closed.close(() => r()));
    const r = await runCheck({ type: "http", method: "GET", expectedStatus: 200, timeoutMs: 3000, target: `http://127.0.0.1:${port}/` });
    expect(r.diagnosis?.kind).toBe("connect");
    expect((await check({ path: "/" })).diagnosis).toBeUndefined();
  });
});
