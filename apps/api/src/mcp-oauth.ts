import type { McpConfig, Monitor, Repo } from "@openuptime/repo";
import type { CheckInput, CheckOutcome } from "./checker";
import { guardedFetch } from "./netguard";
import { sameJson } from "./secrets";

type OAuth = NonNullable<McpConfig["oauth"]>;
const object = (v: unknown): v is Record<string, unknown> => Boolean(v) && typeof v === "object" && !Array.isArray(v);
class OAuthFailure extends Error {}
function fail(message: string): never { throw new OAuthFailure(message); }
function https(value: string) {
  const u = new URL(value);
  if (u.protocol !== "https:" || u.username || u.password || u.hash) fail("OAuth endpoint must use HTTPS without embedded credentials");
  return u;
}
/** No token or authorization-server response body is ever logged or placed in check diagnostics. */
export async function acquireMcpToken(target: string, auth: OAuth, timeoutMs: number): Promise<{ accessToken: string; refreshToken?: string; elapsedMs: number }> {
  const started = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const bounded = async <T>(task: Promise<T>): Promise<T> => {
    if (controller.signal.aborted) { void task.catch(() => {}); fail("OAuth request timed out"); }
    let abort!: () => void;
    const deadline = new Promise<never>((_, reject) => { abort = () => reject(new OAuthFailure("OAuth request timed out")); controller.signal.addEventListener("abort", abort, { once: true }); });
    try { return await Promise.race([task, deadline]); } finally { controller.signal.removeEventListener("abort", abort); }
  };
  const readJson = async (url: string, init: RequestInit = {}) => {
    https(url);
    const { res } = await bounded(guardedFetch(url, { ...init, redirect: "manual", signal: controller.signal }, { follow: false, protectBody: true }));
    if (!res.ok) { void res.body?.cancel().catch(() => {}); fail(`OAuth endpoint returned HTTP ${res.status}`); }
    if (!res.headers.get("content-type")?.toLowerCase().includes("json")) { void res.body?.cancel().catch(() => {}); fail("OAuth endpoint did not return JSON"); }
    const reader = res.body?.getReader();
    if (!reader) fail("Empty OAuth response");
    let text = "", size = 0;
    const decoder = new TextDecoder();
    try {
      for (;;) {
        const { done, value } = await bounded(reader.read());
        if (done) break;
        size += value.byteLength;
        if (size > 64 * 1024) fail("OAuth metadata or token response exceeds size limit");
        text += decoder.decode(value, { stream: true });
      }
      text += decoder.decode();
      let value: unknown;
      try { value = JSON.parse(text); } catch { fail("Invalid OAuth JSON response"); }
      if (!object(value)) fail("Invalid OAuth response");
      return value;
    } finally { void reader.cancel().catch(() => {}); }
  };
  try {
    const endpoint = https(target), issuer = https(auth.issuer);
    if (issuer.search || issuer.hash) fail("Invalid OAuth issuer");
    // Discover the resource without forwarding any user-supplied credentials.
    const { res: challenge } = await bounded(guardedFetch(endpoint.href, { method: "GET", headers: { accept: "application/json, text/event-stream" }, signal: controller.signal }, { follow: false }));
    const www = challenge.headers.get("www-authenticate") ?? "";
    void challenge.body?.cancel().catch(() => {});
    const advertised = /(?:^|[,\s])resource_metadata\s*=\s*"([^"\r\n]+)"/i.exec(www)?.[1];
    const resourcePaths = advertised ? [advertised] : [...new Set([
      new URL(`/.well-known/oauth-protected-resource${endpoint.pathname === "/" ? "" : endpoint.pathname}`, endpoint.origin).href,
      new URL("/.well-known/oauth-protected-resource", endpoint.origin).href,
    ])];
    let resource: Record<string, unknown> | undefined;
    for (const url of resourcePaths) {
      try { resource = await readJson(url); break; } catch (error) { if (controller.signal.aborted || advertised) throw error; }
    }
    if (!resource) fail("OAuth protected-resource discovery failed");
    const expectedResource = auth.resource ?? endpoint.href;
    if (typeof resource.resource !== "string" || new URL(resource.resource).href !== new URL(expectedResource).href) fail("OAuth resource metadata does not match the configured resource");
    if (new URL(expectedResource).origin !== endpoint.origin) fail("OAuth resource must belong to the MCP endpoint origin");
    if (!Array.isArray(resource.authorization_servers) || !resource.authorization_servers.includes(auth.issuer)) fail("Configured OAuth issuer is not advertised by the MCP server");
    const issuerPath = issuer.pathname.replace(/\/$/, "");
    const metadataPaths = [...new Set([
      `${issuer.origin}/.well-known/oauth-authorization-server${issuerPath}`,
      `${issuer.origin}/.well-known/openid-configuration${issuerPath}`,
      `${auth.issuer.replace(/\/$/, "")}/.well-known/openid-configuration`,
    ])];
    let metadata: Record<string, unknown> | undefined;
    for (const url of metadataPaths) {
      try { metadata = await readJson(url); break; } catch (error) { if (controller.signal.aborted) throw error; }
    }
    if (!metadata || metadata.issuer !== auth.issuer) fail("OAuth issuer metadata mismatch");
    if (typeof metadata.token_endpoint !== "string") fail("OAuth metadata has no token endpoint");
    const tokenEndpoint = https(metadata.token_endpoint);
    // Never send client secrets to a host selected only by untrusted discovery metadata.
    if (tokenEndpoint.origin !== issuer.origin) fail("OAuth token endpoint must share the trusted issuer origin");
    if (Array.isArray(metadata.grant_types_supported) && !metadata.grant_types_supported.includes(auth.mode)) fail("OAuth grant is not supported by this issuer");
    const method = auth.tokenAuthMethod ?? "client_secret_basic";
    if (auth.clientSecret && Array.isArray(metadata.token_endpoint_auth_methods_supported) && !metadata.token_endpoint_auth_methods_supported.includes(method)) fail("OAuth client authentication method is not supported");
    const body = new URLSearchParams({ grant_type: auth.mode, resource: expectedResource });
    if (auth.scopes?.length) body.set("scope", auth.scopes.join(" "));
    if (auth.mode === "refresh_token") body.set("refresh_token", auth.refreshToken ?? "");
    const headers = new Headers({ "content-type": "application/x-www-form-urlencoded", accept: "application/json" });
    if (method === "client_secret_basic" && auth.clientSecret) {
      const encode = (v: string) => new URLSearchParams({ v }).toString().slice(2);
      headers.set("authorization", `Basic ${btoa(`${encode(auth.clientId)}:${encode(auth.clientSecret)}`)}`);
    } else {
      body.set("client_id", auth.clientId);
      if (auth.clientSecret) body.set("client_secret", auth.clientSecret);
    }
    const token = await readJson(tokenEndpoint.href, { method: "POST", headers, body: body.toString() });
    if (typeof token.access_token !== "string" || !token.access_token.length || token.access_token.length > 8192 || /[^\x21-\x7e]/.test(token.access_token) || typeof token.token_type !== "string" || token.token_type.toLowerCase() !== "bearer") fail("OAuth server returned an invalid bearer token");
    if (token.expires_in !== undefined && (typeof token.expires_in !== "number" || !Number.isFinite(token.expires_in) || token.expires_in <= 0)) fail("OAuth server returned an expired or invalid token lifetime");
    if (token.refresh_token !== undefined && (typeof token.refresh_token !== "string" || !token.refresh_token.length || token.refresh_token.length > 4000)) fail("OAuth server returned an invalid refresh token");
    return { accessToken: token.access_token, ...(typeof token.refresh_token === "string" ? { refreshToken: token.refresh_token } : {}), elapsedMs: Date.now() - started };
  } catch (error) {
    throw new OAuthFailure(controller.signal.aborted ? "OAuth request timed out" : error instanceof OAuthFailure ? error.message : "OAuth discovery or token request failed");
  } finally { clearTimeout(timer); controller.abort(); }
}

export type PreparedMcp = { input: CheckInput; elapsedMs: number; refreshToken?: string } | { outcome: CheckOutcome; refreshToken?: string };
/** A saved refresh credential is tied to its saved resource and OAuth settings, including the displayed rotation. */
export function mcpRefreshPreviewChanged(input: Pick<CheckInput, "target" | "mcpConfig">, stored: Pick<Monitor, "target" | "mcpConfig">): boolean {
  return (input.mcpConfig?.oauth?.mode === "refresh_token" || stored.mcpConfig?.oauth?.mode === "refresh_token")
    && (input.target !== stored.target || !sameJson(input.mcpConfig?.oauth ?? null, stored.mcpConfig?.oauth ?? null));
}
/** Resolve OAuth once before a multi-region fanout; probes receive only the short-lived access token. */
export async function prepareMcpOAuth(input: CheckInput, repo?: Repo, snapshot?: Monitor): Promise<PreparedMcp> {
  const started = Date.now();
  try {
    if (snapshot && mcpRefreshPreviewChanged(input, snapshot)) fail("Save endpoint and OAuth changes before using a saved refresh credential");
    if (!input.mcpConfig?.oauth) return { input, elapsedMs: 0 };
    const get = async (current: CheckInput, storage?: Repo, stored?: Monitor) => {
      const auth = current.mcpConfig!.oauth!;
      // Rotation may update only the refresh token while we wait for the DB. Never use a credential whose
      // audience, issuer or client identity changed to authorize the caller's earlier target.
      const identity = (value: OAuth | null | undefined) => value ? Object.fromEntries(Object.entries(value).filter(([key]) => key !== "refreshToken")) : null;
      if (current.target !== input.target || !sameJson(identity(auth), identity(input.mcpConfig?.oauth))) fail("OAuth configuration changed while acquiring credentials");
      const acquisitionBudget = input.timeoutMs - (Date.now() - started);
      if (acquisitionBudget <= 0) fail("OAuth check timeout exhausted before token request");
      const token = await acquireMcpToken(current.target, auth, acquisitionBudget);
      if (auth.mode === "refresh_token" && token.refreshToken && token.refreshToken !== auth.refreshToken && storage && stored) {
        if (!(await storage.rotateMcpRefreshToken(stored, auth.refreshToken!, token.refreshToken))) fail("OAuth configuration changed while refreshing credentials");
      }
      const headers = new Headers(input.headers);
      headers.set("authorization", `Bearer ${token.accessToken}`);
      const remaining = input.timeoutMs - (Date.now() - started);
      const headerMap: Record<string, string> = {}; headers.forEach((value, key) => { headerMap[key] = value; });
      return { input: { ...input, headers: headerMap, mcpConfig: { ...input.mcpConfig!, oauth: null }, timeoutMs: Math.max(1, remaining) }, elapsedMs: Date.now() - started, refreshToken: token.refreshToken };
    };
    const finish = (prepared: Awaited<ReturnType<typeof get>>): PreparedMcp => {
      // Include the transaction commit, not just token acquisition, in the remaining protocol budget.
      // A rotated token is persisted first even if the remaining check must be reported as timed out.
      const elapsedMs = Date.now() - started;
      if (elapsedMs >= input.timeoutMs) return { outcome: { ok: false, latencyMs: elapsedMs, error: "MCP oauth: check timeout exhausted", mcp: { stage: "oauth", timings: { oauth: elapsedMs }, tools: [], changes: [] } }, refreshToken: prepared.refreshToken };
      return { ...prepared, elapsedMs, input: { ...prepared.input, timeoutMs: input.timeoutMs - elapsedMs } };
    };
    if (input.mcpConfig.oauth.mode === "refresh_token" && repo && snapshot) {
      const prepared = await repo.withMcpOAuth(snapshot, (tx, current) => get(current, tx, current));
      if (!prepared) return { outcome: { ok: false, inconclusive: true, error: "MCP oauth: refresh already running or configuration changed" } };
      return finish(prepared);
    }
    const prepared = await get(input);
    return finish(prepared);
  } catch (error) {
    const latencyMs = Date.now() - started;
    return { outcome: { ok: false, latencyMs, error: `MCP oauth: ${error instanceof OAuthFailure ? error.message : "OAuth request failed"}`, mcp: { stage: "oauth", timings: { oauth: latencyMs }, tools: [], changes: [] } } };
  }
}

export function addOAuthTiming(out: CheckOutcome, elapsedMs: number): CheckOutcome {
  if (!elapsedMs) return out;
  return { ...out, latencyMs: (out.latencyMs ?? 0) + elapsedMs, ...(out.mcp ? { mcp: { ...out.mcp, timings: { oauth: elapsedMs, ...out.mcp.timings } } } : {}) };
}
