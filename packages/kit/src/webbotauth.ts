/**
 * Web Bot Auth: HTTP checks sign their requests (RFC 9421, Ed25519) so a site behind a bot filter can verify they come
 * from this deployment instead of trusting a User-Agent or an IP range. Runs on Node and on Workers (WebCrypto only).
 *
 * A request carries three headers: `Signature-Agent` (the https origin that serves the public key), `Signature-Input`
 * and `Signature`. The public key is published as a signed JWKS at `/.well-known/http-message-signatures-directory` of
 * that origin; `directoryResponse` builds it.
 */

const TAG_REQUEST = "web-bot-auth";
const TAG_DIRECTORY = "http-message-signatures-directory";
/** A signature is valid for this many seconds: long enough for clock drift, short enough to make a replay pointless. */
const LIFETIME_SEC = 60;

export const DIRECTORY_PATH = "/.well-known/http-message-signatures-directory";
export const DIRECTORY_CONTENT_TYPE = "application/http-message-signatures-directory+json";

export type SigningConfig = {
  /** The private key as a JWK (JSON): `{"kty":"OKP","crv":"Ed25519","x":"…","d":"…"}`. */
  key?: string;
  /** Origin that serves the key directory, e.g. https://openuptime.app. Must be https. */
  agent?: string;
};

type Loaded = { privateKey: CryptoKey; x: string; keyid: string; agent: string };

const enc = new TextEncoder();

export const b64url = (bytes: ArrayBuffer | Uint8Array): string => {
  const u = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let s = "";
  for (const b of u) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};
const b64 = (bytes: ArrayBuffer) => btoa(String.fromCharCode(...new Uint8Array(bytes)));

/** RFC 7638 / RFC 8037 thumbprint of an Ed25519 public key: the key id Cloudflare matches against the directory. */
export async function thumbprint(x: string): Promise<string> {
  return b64url(await crypto.subtle.digest("SHA-256", enc.encode(`{"crv":"Ed25519","kty":"OKP","x":"${x}"}`)));
}

/** The https origin a Signature-Agent header may name; null when the setting is not one. */
export function agentOrigin(value: string | undefined): string | null {
  if (!value?.trim()) return null;
  try {
    const u = new URL(value.trim());
    return u.protocol === "https:" && !u.username && !u.password ? u.origin : null;
  } catch {
    return null;
  }
}

let current: SigningConfig = {};
let loaded: { source: string; value: Promise<Loaded | null> } | null = null;
let warned = false;

/** Env values are constant per deployment, so a module-level setting is safe in a Worker isolate. */
export function configureWebBotAuth(config: SigningConfig) {
  current = { key: config.key?.trim() || undefined, agent: config.agent?.trim() || undefined };
}

async function load(config: SigningConfig): Promise<Loaded | null> {
  const agent = agentOrigin(config.agent);
  if (!config.key || !agent) return null;
  const jwk = JSON.parse(config.key) as { kty?: string; crv?: string; x?: string; d?: string };
  if (jwk.kty !== "OKP" || jwk.crv !== "Ed25519" || !jwk.x || !jwk.d) throw new Error("CHECK_SIGNING_KEY must be an Ed25519 private key as a JWK (kty OKP, crv Ed25519, with x and d)");
  const privateKey = await crypto.subtle.importKey("jwk", { kty: "OKP", crv: "Ed25519", x: jwk.x, d: jwk.d }, { name: "Ed25519" }, false, ["sign"]);
  return { privateKey, x: jwk.x, keyid: await thumbprint(jwk.x), agent };
}

/** The configured key, imported once per distinct setting; null when signing is off or the setting is unusable. */
function signer(): Promise<Loaded | null> {
  const source = `${current.agent ?? ""}\n${current.key ?? ""}`;
  if (!loaded || loaded.source !== source) {
    const value = load(current).catch((e) => {
      // a broken setting must not break checks: they go out unsigned, and the operator is told once
      if (!warned) { warned = true; console.warn(`Web Bot Auth is off: ${(e as Error).message}`); }
      return null;
    });
    loaded = { source, value };
  }
  return loaded.value;
}

export const webBotAuthEnabled = async () => (await signer()) != null;

/** 64 random bytes, as the Web Bot Auth draft and Cloudflare's reference verifier require. */
const nonce = () => b64url(crypto.getRandomValues(new Uint8Array(64)));

async function sign(key: Loaded, base: string): Promise<string> {
  return b64(await crypto.subtle.sign({ name: "Ed25519" }, key.privateKey, enc.encode(base)));
}

/** The three headers that sign a request to `url`, or null when signing is not configured. */
export async function signRequest(url: URL, now = Date.now()): Promise<Record<string, string> | null> {
  const key = await signer();
  if (!key) return null;
  const created = Math.floor(now / 1000);
  const agentValue = `"${key.agent}"`;
  const params = `("@authority" "signature-agent");created=${created};expires=${created + LIFETIME_SEC};keyid="${key.keyid}";alg="ed25519";nonce="${nonce()}";tag="${TAG_REQUEST}"`;
  const base = `"@authority": ${url.host.toLowerCase()}\n"signature-agent": ${agentValue}\n"@signature-params": ${params}`;
  return { "signature-agent": agentValue, "signature-input": `sig1=${params}`, signature: `sig1=:${await sign(key, base)}:` };
}

/** What the key directory answers: the public key as a JWKS, signed over the authority it was asked for. Null when off. */
export async function directoryResponse(authority: string, now = Date.now()): Promise<Response | null> {
  const key = await signer();
  if (!key) return null;
  const created = Math.floor(now / 1000);
  const params = `("@authority";req);created=${created};expires=${created + LIFETIME_SEC};keyid="${key.keyid}";alg="ed25519";nonce="${nonce()}";tag="${TAG_DIRECTORY}"`;
  const base = `"@authority";req: ${authority.toLowerCase()}\n"@signature-params": ${params}`;
  return new Response(JSON.stringify({ keys: [{ kty: "OKP", crv: "Ed25519", x: key.x }] }), {
    headers: {
      "content-type": DIRECTORY_CONTENT_TYPE,
      "cache-control": "no-store",
      "signature-input": `sig1=${params}`,
      signature: `sig1=:${await sign(key, base)}:`,
    },
  });
}
