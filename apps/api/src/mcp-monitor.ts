import type { McpConfig, McpObservation, McpToolSchema } from "@openuptime/repo";
import type { CheckOutcome } from "./checker";
import { targetIsPrivate } from "./netguard";
import { McpClient, McpFailure } from "./mcp-monitor-transport";
import { mcpSchemaDrift } from "./mcp-monitor-schema";
export { mcpSchemaDrift, mcpSchemaChanges, mcpToolsEqual } from "./mcp-monitor-schema";
export { MCP_PROTOCOL_VERSIONS, MCP_MAX_RESPONSE_BYTES, MCP_MAX_TOTAL_BYTES, MCP_MAX_RESUMES } from "./mcp-monitor-transport";
import { networkLevelError, proberOnline, proberSideError } from "./selfcheck";

export const MCP_MAX_PAGES = 20;
export const MCP_MAX_TOOLS = 1000;
const MAX_SCHEMA_DEPTH = 32;
type Obj = Record<string, unknown>;
const object = (v: unknown): v is Obj => v !== null && typeof v === "object" && !Array.isArray(v);
const own = (o: object, k: string) => Object.prototype.hasOwnProperty.call(o, k);
function fail(message: string): never { throw new McpFailure(message); }

/** Bound even annotation/default/enum payloads before walking schemas, without recursively trusting JSON input. */
function boundedSchema(raw: Obj) {
  const pending: { value: unknown; depth: number }[] = [{ value: raw, depth: 0 }];
  let nodes = 0;
  while (pending.length) {
    const { value, depth } = pending.pop()!;
    if (++nodes > 20_000 || depth > MAX_SCHEMA_DEPTH) fail("Tool schema exceeds complexity limit");
    if (value !== null && typeof value === "object") {
      for (const child of Object.values(value)) pending.push({ value: child, depth: depth + 1 });
    }
  }
}

/** Retain the contract and descriptions, not examples/default argument values or tool results. */
export function mcpSchemaShape(raw: Obj, depth = 0): Obj {
  if (depth === 0) boundedSchema(raw);
  if (depth > MAX_SCHEMA_DEPTH) return fail("Tool schema exceeds nesting limit");
  // Unknown schema keywords may impose constraints in another dialect or extension. Preserve them for
  // exact cross-region comparison and warning-level drift instead of silently projecting them away.
  const result: Obj = Object.fromEntries(Object.entries(raw).filter(([key]) => key !== "default" && key !== "examples"));
  for (const key of ["type", "$ref", "$dynamicRef", "$id", "$schema", "description", "title", "x-mcp-header", "required", "enum", "const", "additionalProperties", "minItems", "maxItems", "minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum", "minLength", "maxLength", "minContains", "maxContains", "minProperties", "maxProperties", "multipleOf", "uniqueItems", "pattern", "format"] as const) {
    if (own(raw, key)) result[key] = raw[key];
  }
  for (const key of ["properties", "$defs", "definitions", "patternProperties", "dependentSchemas"] as const) {
    const children = raw[key];
    if (children === undefined) continue;
    if (!object(children)) return fail("Invalid tool schema");
    result[key] = Object.fromEntries(Object.entries(children).map(([name, value]) => {
      if (typeof value === "boolean") return [name, value];
      if (!object(value)) return fail("Invalid tool schema");
      return [name, mcpSchemaShape(value, depth + 1)];
    }));
  }
  for (const key of ["items", "additionalProperties", "contains", "not", "if", "then", "else", "propertyNames", "unevaluatedProperties", "unevaluatedItems"] as const) {
    if (object(raw[key])) result[key] = mcpSchemaShape(raw[key], depth + 1);
    else if (typeof raw[key] === "boolean") result[key] = raw[key];
  }
  for (const key of ["allOf", "anyOf", "oneOf", "prefixItems"] as const) {
    const children = raw[key];
    if (children === undefined) continue;
    if (!Array.isArray(children)) return fail("Invalid tool schema");
    result[key] = children.map(value => {
      if (typeof value === "boolean") return value;
      if (!object(value)) return fail("Invalid tool schema");
      return mcpSchemaShape(value, depth + 1);
    });
  }
  if (raw.required !== undefined && (!Array.isArray(raw.required) || raw.required.some(v => typeof v !== "string"))) return fail("Invalid tool schema required parameters");
  if (raw.dependentRequired !== undefined) {
    if (!object(raw.dependentRequired) || Object.values(raw.dependentRequired).some(v => !Array.isArray(v) || v.some(name => typeof name !== "string"))) return fail("Invalid tool schema conditional required parameters");
    result.dependentRequired = raw.dependentRequired;
  }
  const types = new Set(["null", "boolean", "object", "array", "number", "string", "integer"]);
  if (raw.type !== undefined && !(typeof raw.type === "string" && types.has(raw.type)) && !(Array.isArray(raw.type) && raw.type.length && raw.type.every(v => typeof v === "string" && types.has(v)))) return fail("Invalid tool schema type");
  for (const key of ["$ref", "$dynamicRef", "$id", "$schema", "description", "title", "pattern", "format"]) if (raw[key] !== undefined && typeof raw[key] !== "string") return fail("Invalid tool schema");
  for (const key of ["minItems", "maxItems", "minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum", "minLength", "maxLength", "minContains", "maxContains", "minProperties", "maxProperties", "multipleOf"]) if (raw[key] !== undefined && (typeof raw[key] !== "number" || !Number.isFinite(raw[key]))) return fail("Invalid tool schema numeric constraint");
  if (raw.enum !== undefined && !Array.isArray(raw.enum)) return fail("Invalid tool schema enum");
  return result;
}

function equal(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((v, i) => equal(v, b[i]));
  if (!object(a) || !object(b)) return false;
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length && keys.every(k => own(b, k) && equal(a[k], b[k]));
}

/** RFC 6901 JSON Pointer into the complete tools/call result; inherited properties are never accessible. */
export function mcpAssertionPasses(result: unknown, assertion: NonNullable<McpConfig["toolCall"]>["assertions"][number]): boolean {
  if (assertion.path !== "" && !assertion.path.startsWith("/")) return false;
  let found = true, value = result;
  for (const encoded of assertion.path === "" ? [] : assertion.path.slice(1).split("/")) {
    if (/~(?:[^01]|$)/.test(encoded)) return false;
    const key = encoded.replace(/~1/g, "/").replace(/~0/g, "~");
    if (Array.isArray(value) && !/^(0|[1-9]\d*)$/.test(key)) return false;
    if ((!object(value) && !Array.isArray(value)) || !own(value, key)) { found = false; break; }
    value = (value as Obj)[key];
  }
  if (assertion.operator === "exists") return found;
  if (!found) return false;
  if (assertion.operator === "equals") return equal(value, assertion.value);
  if (assertion.operator === "contains") return typeof value === "string" && typeof assertion.value === "string" ? value.includes(assertion.value) : Array.isArray(value) && value.some(v => equal(v, assertion.value));
  return false;
}

/** Required discriminated content fields from the supported 2025 MCP wire schemas. No payload is retained. */
function validToolContent(value: unknown): boolean {
  if (!object(value)) return false;
  switch (value.type) {
    case "text": return typeof value.text === "string";
    case "image":
    case "audio": return typeof value.data === "string" && typeof value.mimeType === "string";
    case "resource_link": return typeof value.uri === "string" && typeof value.name === "string" && (value.mimeType === undefined || typeof value.mimeType === "string");
    case "resource": {
      const resource = value.resource;
      return object(resource) && typeof resource.uri === "string" && (resource.mimeType === undefined || typeof resource.mimeType === "string") && (typeof resource.text === "string" || typeof resource.blob === "string");
    }
    default: return false;
  }
}

export async function mcpCheck(input: { target: string; timeoutMs: number; headers?: Record<string, string>; mcpConfig?: McpConfig | null; mcpBaseline?: McpToolSchema[] | null }): Promise<CheckOutcome & { mcp: McpObservation }> {
  const started = Date.now();
  const observation: McpObservation = { stage: "initialize", timings: {}, tools: [], changes: [] };
  const config = input.mcpConfig ?? { requiredTools: [], schemaCheck: false, toolCall: null };
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), input.timeoutMs);
  const client = new McpClient({ target: input.target, headers: input.headers, transport: config.transport }, controller.signal);
  const request = (method: string, params: Obj = {}) => client.call(method, params);
  const stage = async <T>(name: McpObservation["stage"], run: () => Promise<T> | T): Promise<T> => {
    observation.stage = name;
    const before = Date.now();
    try { return await run(); }
    finally { observation.timings[name] = (observation.timings[name] ?? 0) + Date.now() - before; }
  };
  try {
    const url = new URL(input.target);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.hash) fail("MCP requires an HTTP(S) URL without credentials or fragment");
    const capabilities = await client.connect(stage);
    observation.protocolVersion = client.protocolVersion ?? undefined;
    observation.transport = client.transport;
    await stage("tools/list", async () => {
      if (!object(capabilities.tools)) fail("Server does not advertise the tools capability");
      const tools: McpToolSchema[] = [], names = new Set<string>(), cursors = new Set<string>();
      let cursor: string | undefined;
      for (let page = 0; page < MCP_MAX_PAGES; page++) {
        const listed = await request("tools/list", cursor === undefined ? {} : { cursor });
        if (!Array.isArray(listed.tools)) fail("Invalid tools/list result");
        for (const tool of listed.tools) {
          if (!object(tool) || typeof tool.name !== "string" || !tool.name.length || tool.name.length > 128 || /[\u0000-\u001f\u007f]/.test(tool.name) || !object(tool.inputSchema) || tool.inputSchema.type !== "object") fail("Invalid tool definition");
          if (names.has(tool.name)) fail("Duplicate tool name in tools/list");
          names.add(tool.name);
          if (names.size > MCP_MAX_TOOLS) fail("MCP tool count exceeds limit");
          if (tool.description !== undefined && typeof tool.description !== "string" || tool.annotations !== undefined && !object(tool.annotations) || tool.outputSchema !== undefined && (!object(tool.outputSchema) || tool.outputSchema.type !== "object")) fail("Invalid tool metadata or output schema");
          const definition: McpToolSchema = { name: tool.name, inputSchema: mcpSchemaShape(tool.inputSchema) };
          if (typeof tool.description === "string") definition.description = tool.description;
          if (object(tool.annotations)) { boundedSchema(tool.annotations); definition.annotations = tool.annotations; }
          if (object(tool.outputSchema)) definition.outputSchema = mcpSchemaShape(tool.outputSchema);
          if (!client.registerTool(tool.name, tool.inputSchema)) {
            (observation.drift ??= []).push({ severity: "warning", kind: "invalid-header-annotation", tool: tool.name, message: "Tool excluded because its MCP parameter header annotation is invalid" });
            continue;
          }
          tools.push(definition);
        }
        if (listed.nextCursor === undefined) { observation.tools = tools; observation.toolsComplete = true; return; }
        if (typeof listed.nextCursor !== "string" || !listed.nextCursor.length || listed.nextCursor.length > 4096 || cursors.has(listed.nextCursor)) fail("Invalid or repeated MCP pagination cursor");
        cursor = listed.nextCursor;
        cursors.add(cursor);
      }
      fail("MCP pagination exceeds page limit");
    });
    // Keep the complete contract diff even when a required tool or optional inventory fails next. Otherwise
    // deleting a required tool would open an outage but disappear from the schema-change history.
    if (config.schemaCheck && input.mcpBaseline != null) {
      const drift = mcpSchemaDrift(input.mcpBaseline, observation.tools);
      observation.drift = [...drift, ...observation.drift ?? []].slice(0, 100);
      observation.changes = drift.filter(change => change.severity === "breaking").map(change => change.message);
    }
    await stage("required-tools", () => {
      const names = new Set(observation.tools.map(t => t.name));
      const missing = config.requiredTools.filter(name => !names.has(name));
      if (missing.length) fail(`Required tools missing (${missing.length})`);
    });
    const inventory = async (kind: "prompts" | "resources") => stage(`${kind}/list`, async () => {
      if (!object(capabilities[kind])) fail(`Server does not advertise the ${kind} capability`);
      const entries: { name: string; uri: string }[] = [], seen = new Set<string>(), cursors = new Set<string>();
      let cursor: string | undefined;
      for (let page = 0; page < MCP_MAX_PAGES; page++) {
        const result = await request(`${kind}/list`, cursor === undefined ? {} : { cursor });
        if (!Array.isArray(result[kind])) fail(`Invalid ${kind}/list result`);
        for (const item of result[kind]) {
          if (!object(item) || typeof item.name !== "string" || !item.name.length || item.name.length > 256 || kind === "resources" && (typeof item.uri !== "string" || !item.uri.length || item.uri.length > 2048)) fail(`Invalid ${kind}/list entry`);
          const key = kind === "resources" ? item.uri as string : item.name;
          if (seen.has(key)) fail(`Duplicate ${kind}/list entry`);
          seen.add(key); entries.push({ name: item.name, uri: kind === "resources" ? item.uri as string : "" });
          if (entries.length > MCP_MAX_TOOLS) fail(`MCP ${kind} count exceeds limit`);
        }
        if (result.nextCursor === undefined) {
          if (kind === "prompts") observation.prompts = entries.map(({ name }) => ({ name }));
          else observation.resources = entries;
          return;
        }
        if (typeof result.nextCursor !== "string" || !result.nextCursor.length || result.nextCursor.length > 4096 || cursors.has(result.nextCursor)) fail(`Invalid or repeated ${kind} pagination cursor`);
        cursor = result.nextCursor; cursors.add(cursor);
      }
      fail(`MCP ${kind} pagination exceeds page limit`);
    });
    if (config.listPrompts) await inventory("prompts");
    if (config.listResources) await inventory("resources");
    if (config.schemaCheck) await stage("schema", () => {
      if (observation.changes.length && (config.driftPolicy ?? "down") === "down") fail(`Breaking tool schema change (${observation.changes.length} detected)`);
    });
    // Never infer permission from a tool's readOnlyHint or a saved name/arguments. Only the explicit boolean enables calls.
    if (config.toolCall?.enabled === true) {
      const call = config.toolCall;
      const result = await stage("tools/call", async () => {
        if (!observation.tools.some(tool => tool.name === call.name)) fail("Selected probe tool is not available");
        const result = await request("tools/call", { name: call.name, arguments: call.arguments });
        if (result.isError !== undefined && typeof result.isError !== "boolean") fail("Invalid tools/call isError flag");
        if (result.isError === true) fail("Tool returned isError=true");
        if (!Array.isArray(result.content) || result.content.some(item => !validToolContent(item)) || (result.structuredContent !== undefined && !object(result.structuredContent))) fail("Invalid tools/call result");
        return result;
      });
      if (call.assertions.length) await stage("assertions", () => {
        for (let i = 0; i < call.assertions.length; i++) if (!mcpAssertionPasses(result, call.assertions[i])) fail(`Tool result assertion ${i + 1} failed`);
      });
    }
    observation.stage = "complete";
    return { ok: true, latencyMs: Date.now() - started, statusCode: client.statusCode, mcp: observation, ...(observation.changes.length && config.driftPolicy === "degraded" ? { degraded: true } : {}) };
  } catch (error) {
    let inconclusive = false;
    if (!(error instanceof McpFailure) && networkLevelError(error)) {
      let privateTarget = false;
      try { privateTarget = await targetIsPrivate(new URL(input.target).hostname); } catch { /* invalid URL */ }
      inconclusive = proberSideError(error) || (!privateTarget && !(await proberOnline()));
    }
    const reason = controller.signal.aborted ? "Request timed out" : error instanceof McpFailure ? error.message : error instanceof Error && error.name === "BlockedTarget" ? "Target refused by network policy" : "MCP request failed";
    return { ok: false, latencyMs: Date.now() - started, statusCode: client.statusCode, error: `MCP ${observation.stage}: ${reason}`, mcp: observation, ...(inconclusive ? { inconclusive: true } : {}) };
  } finally {
    observation.protocolVersion = client.protocolVersion ?? undefined;
    observation.transport = client.transport;
    await client.close();
    clearTimeout(timeout);
    controller.abort();
  }
}
