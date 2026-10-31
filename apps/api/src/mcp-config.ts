import { z } from "zod";
const httpsUrl = (value: string) => { try { const u = new URL(value); return u.protocol === "https:" && !u.username && !u.password && !u.hash && !u.search; } catch { return false; } };
/** Tool calls are opt-in. Payloads and assertions may hold secrets, just like headers. */
const boundedJson = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).byteLength <= 16_384;
/**
 * A stored refresh token rotates on every check, so a client copy is always potentially stale. Updates and saved-monitor
 * previews may omit it to mean "keep the stored token"; creation and probes require the complete credentials.
 */
const buildMcpConfigSchema = (refreshTokenRequired: boolean) => z.object({
  requiredTools: z.array(z.string().trim().min(1).max(128)).max(100).default([]),
  schemaCheck: z.boolean().default(false),
  transport: z.enum(["auto", "streamable-http", "sse"]).optional(),
  listPrompts: z.boolean().optional(),
  listResources: z.boolean().optional(),
  driftPolicy: z.enum(["down", "degraded", "record"]).optional(),
  oauth: z.object({
    mode: z.enum(["client_credentials", "refresh_token"]),
    issuer: z.string().url().max(2048).refine(httpsUrl, "OAuth issuer must be an HTTPS URL without credentials, query or fragment"),
    clientId: z.string().min(1).max(1000),
    clientSecret: z.string().max(4000).optional(),
    refreshToken: z.string().max(4000).optional(),
    scopes: z.array(z.string().min(1).max(200).regex(/^[\x21\x23-\x5b\x5d-\x7e]+$/)).max(30).optional(),
    resource: z.string().url().max(2048).refine(httpsUrl, "OAuth resource must be an HTTPS URL").optional(),
    tokenAuthMethod: z.enum(["client_secret_basic", "client_secret_post"]).optional(),
  }).refine(v => !refreshTokenRequired || v.mode !== "refresh_token" || Boolean(v.refreshToken), "Refresh-token mode requires a refresh token")
    .refine(v => v.mode !== "client_credentials" || Boolean(v.clientSecret), "Client-credentials mode requires a client secret").nullable().optional(),
  toolCall: z.object({
    enabled: z.boolean().default(false),
    name: z.string().trim().max(128).default(""),
    arguments: z.record(z.string(), z.unknown()).refine(boundedJson, "Tool arguments exceed 16384 UTF-8 bytes").default({}),
    assertions: z.array(z.object({
      path: z.string().max(500).refine(v => v === "" || (v.startsWith("/") && !/~(?![01])/.test(v)), "Use a JSON Pointer"),
      operator: z.enum(["equals", "contains", "exists"]),
      value: z.unknown().optional(),
    }).refine(v => v.operator === "exists" || v.value !== undefined, "This assertion requires a value")).max(20).default([]),
  }).nullable().default(null),
}).refine(v => !v.toolCall?.enabled || Boolean(v.toolCall.name), "An enabled tool call requires a tool name")
  .refine(boundedJson, "MCP configuration exceeds 16384 UTF-8 bytes");
export const mcpConfigSchema = buildMcpConfigSchema(true);
/** PATCH and saved-monitor preview: an omitted oauth.refreshToken keeps the stored one. */
export const mcpConfigPatchSchema = buildMcpConfigSchema(false);


const oneMiB = 1024 * 1024;
const tool = z.object({ name: z.string().min(1).max(128), inputSchema: z.record(z.string(), z.unknown()), outputSchema: z.record(z.string(), z.unknown()).optional(), description: z.string().max(oneMiB).refine(value => new TextEncoder().encode(value).byteLength <= oneMiB, "MCP description exceeds 1 MiB").optional(), annotations: z.record(z.string(), z.unknown()).optional() });
const stage = z.enum(["oauth", "server/discover", "initialize", "initialized", "tools/list", "prompts/list", "resources/list", "required-tools", "schema", "tools/call", "assertions", "complete"]);
const timings = z.record(z.string().max(80), z.number().finite().nonnegative());
export const mcpToolsSchema = z.array(tool).max(1000);
/** A signed probe is still validated before its diagnostics can become a persistent baseline. */
export const mcpObservationSchema = z.object({
  stage, timings, toolsComplete: z.boolean().optional(), tools: mcpToolsSchema, changes: z.array(z.string().max(500)).max(100),
  protocolVersion: z.string().max(40).optional(), transport: z.enum(["streamable-http", "sse"]).optional(),
  prompts: z.array(z.object({ name: z.string().max(256) })).max(1000).optional(),
  resources: z.array(z.object({ uri: z.string().max(2048), name: z.string().max(256) })).max(1000).optional(),
  drift: z.array(z.object({ severity: z.enum(["breaking", "warning", "info"]), kind: z.string().max(100), tool: z.string().max(256), path: z.string().max(2048).optional(), message: z.string().max(500) })).max(100).optional(),
}).refine(value => {
  try { return new TextEncoder().encode(JSON.stringify(value)).byteLength <= 4 * oneMiB; } catch { return false; }
}, "MCP observation exceeds 4 MiB");
