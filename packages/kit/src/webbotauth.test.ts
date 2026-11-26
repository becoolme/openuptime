import { generateKeyPairSync, verify } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { verify as referenceVerify } from "web-bot-auth";
import { guardedFetch } from "./netguard";
import { DIRECTORY_CONTENT_TYPE, agentOrigin, configureWebBotAuth, directoryResponse, signRequest, thumbprint, b64url } from "./webbotauth";

const { privateKey, publicKey } = generateKeyPairSync("ed25519");
const jwk = privateKey.export({ format: "jwk" }) as { x: string; d: string };
const KEY = JSON.stringify({ kty: "OKP", crv: "Ed25519", x: jwk.x, d: jwk.d });
const AGENT = "https://bot.example.com";
const pub = publicKey;
const valid = (base: string, sig: string) => verify(null, Buffer.from(base), pub, Buffer.from(sig, "base64"));
const sigValue = (h: string | Headers | Record<string, string>, name = "signature") => {
  const v = (h instanceof Headers ? h.get(name) : (h as Record<string, string>)[name])!;
  return /^sig1=:(.+):$/.exec(v)![1];
};

beforeEach(() => configureWebBotAuth({ key: KEY, agent: AGENT }));

describe("web bot auth", () => {
  it("matches the RFC 8037 thumbprint example", async () => {
    expect(await thumbprint("11qYAYKxCrfVS_7TyWQHOg7hcvPapiMlrwIaaPcHURo")).toBe("kPrK_qmxVWaYVA9wwBF6Iuo3vVzz7TxHCTwXBygrS4k");
  });

  it("signs a request over the authority and the agent, with a signature a verifier can check", async () => {
    const now = 1_800_000_000_000;
    const h = (await signRequest(new URL("https://Example.com:8443/a?b=1"), now))!;
    expect(h["signature-agent"]).toBe(`"${AGENT}"`);
    const input = h["signature-input"];
    expect(input).toMatch(/^sig1=\("@authority" "signature-agent"\);created=1800000000;expires=1800000060;keyid="[\w-]{43}";alg="ed25519";nonce="[\w-]+";tag="web-bot-auth"$/);
    expect(input).toContain(`keyid="${await thumbprint(jwk.x)}"`);
    const base = `"@authority": example.com:8443\n"signature-agent": "${AGENT}"\n"@signature-params": ${input.slice(5)}`;
    expect(valid(base, sigValue(h))).toBe(true);
    expect(valid(base.replace("example.com", "evil.com"), sigValue(h))).toBe(false);
  });

  it("answers the key directory with a signed JWKS", async () => {
    const res = (await directoryResponse("Bot.Example.com", 1_800_000_000_000))!;
    expect(res.headers.get("content-type")).toBe(DIRECTORY_CONTENT_TYPE);
    expect(await res.json()).toEqual({ keys: [{ kty: "OKP", crv: "Ed25519", x: jwk.x }] });
    const input = res.headers.get("signature-input")!;
    expect(input).toMatch(/^sig1=\("@authority";req\);created=1800000000;expires=1800000060;.*;tag="http-message-signatures-directory"$/);
    expect(valid(`"@authority";req: bot.example.com\n"@signature-params": ${input.slice(5)}`, sigValue(res.headers))).toBe(true);
    expect(b64url(Buffer.from(jwk.d, "base64url"))).toBe(jwk.d); // the private half is never published
    expect(JSON.stringify(await directoryResponse("x"))).not.toContain(jwk.d);
  });

  it("is off without a usable key or an https agent, and a broken key does not throw", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    for (const config of [{}, { key: KEY }, { agent: AGENT }, { key: KEY, agent: "http://bot.example.com" }, { key: "not json", agent: AGENT }, { key: JSON.stringify({ kty: "RSA" }), agent: AGENT }]) {
      configureWebBotAuth(config);
      expect(await signRequest(new URL("https://example.com/"))).toBeNull();
      expect(await directoryResponse("example.com")).toBeNull();
    }
    warn.mockRestore();
    expect(agentOrigin("https://bot.example.com/path")).toBe("https://bot.example.com");
    expect(agentOrigin("https://u:p@bot.example.com")).toBeNull();
  });
});

describe("interoperability with Cloudflare's reference verifier", () => {
  it("accepts a signed request, and a request whose host was changed is refused", async () => {
    const keyid = await thumbprint(jwk.x);
    const verifier = { algorithm: "ed25519" as const, keyid, verify: (data: Uint8Array, sig: Uint8Array) => verify(null, data, pub, sig) };
    const url = "https://target.example.org/health";
    const headers = (await signRequest(new URL(url)))!;
    const ok = await referenceVerify(new Request(url, { headers }), { resolver: () => verifier });
    expect(ok.keyid).toBe(keyid);
    expect(ok.tag).toBe("web-bot-auth");
    await expect(referenceVerify(new Request("https://other.example.org/health", { headers }), { resolver: () => verifier })).rejects.toThrow();
  });
});

describe("guardedFetch signing", () => {
  const seen: Array<{ url: string; headers: Headers }> = [];
  beforeEach(() => {
    seen.length = 0;
    vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit) => {
      seen.push({ url, headers: new Headers(init.headers) });
      return seen.length === 1 ? new Response(null, { status: 302, headers: { location: "https://1.1.1.1/next" } }) : new Response("ok");
    }));
  });

  it("signs each hop for its own host and ignores signature headers a monitor set", async () => {
    await guardedFetch("https://8.8.8.8/start", { headers: { signature: "sig1=:forged:", "signature-agent": '"https://evil"' } }, { sign: true });
    expect(seen.map((s) => new URL(s.url).host)).toEqual(["8.8.8.8", "1.1.1.1"]);
    for (const s of seen) {
      const host = new URL(s.url).host;
      const base = `"@authority": ${host}\n"signature-agent": "${AGENT}"\n"@signature-params": ${s.headers.get("signature-input")!.slice(5)}`;
      expect(s.headers.get("signature-agent")).toBe(`"${AGENT}"`);
      expect(valid(base, sigValue(s.headers))).toBe(true);
    }
  });

  it("leaves requests unsigned unless asked to sign", async () => {
    await guardedFetch("https://8.8.8.8/start", {}, { follow: false });
    expect(seen[0].headers.get("signature")).toBeNull();
  });
});
