import { checkUserAgent, guardedFetch } from "./netguard";
import { networkLevelError } from "./selfcheck";

type Obj = Record<string, unknown>;
const object = (v: unknown): v is Obj => v !== null && typeof v === "object" && !Array.isArray(v);
const own = (o: object, k: string) => Object.prototype.hasOwnProperty.call(o, k);
export const MODERN_MCP_VERSION = "2026-07-28";
export const MCP_PROTOCOL_VERSIONS = [MODERN_MCP_VERSION, "2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"] as const;
export const MCP_MAX_RESPONSE_BYTES = 1024 * 1024;
export const MCP_MAX_TOTAL_BYTES = 4 * MCP_MAX_RESPONSE_BYTES;
export const MCP_MAX_RESUMES = 3;
export class McpFailure extends Error {}
function fail(message: string): never { throw new McpFailure(message); }
class HttpFailure extends McpFailure { constructor(readonly status: number) { super(`HTTP ${status}; redirects are not followed`); } }
class RpcFailure extends McpFailure {
  constructor(readonly code: number, readonly status: number, readonly supported: string[] = []) { super(`JSON-RPC error (${code})`); }
}
class StreamEnded extends Error {}
const modernError = (error: unknown) => error instanceof RpcFailure && ([-32020, -32021, -32022].includes(error.code) || error.status === 404 && error.code === -32601);
const fallbackError = (error: unknown) => !modernError(error) && (error instanceof HttpFailure && [400, 404, 405].includes(error.status) || error instanceof RpcFailure && (error.status === 400 || error.status === 200 && error.code === -32601));

function responseResult(raw: unknown, id: number, status: number, streamed = false): Obj | null {
  if (!object(raw) || raw.jsonrpc !== "2.0") fail("Invalid JSON-RPC response");
  if (streamed && typeof raw.method === "string" && !own(raw, "id") && !own(raw, "result") && !own(raw, "error")) return null;
  if (raw.id !== id || own(raw, "method") || own(raw, "result") === own(raw, "error")) fail("Invalid JSON-RPC response envelope or request ID");
  if (own(raw, "error")) {
    if (!object(raw.error) || !Number.isInteger(raw.error.code) || typeof raw.error.message !== "string") fail("Invalid JSON-RPC error");
    const versions = object(raw.error.data) && Array.isArray(raw.error.data.supported) ? raw.error.data.supported.filter((v): v is string => typeof v === "string").slice(0, 20) : [];
    throw new RpcFailure(raw.error.code as number, status, versions);
  }
  if (!object(raw.result)) fail("Invalid JSON-RPC result");
  return raw.result;
}

/** Header sentinel encoding is also required for plain strings that already look like a sentinel. */
export function mcpHeaderValue(value: string): string {
  if (/^[\x20-\x7e\t]*$/.test(value) && value.trim() === value && !/^=\?base64\?.*\?=$/.test(value)) return value;
  const bytes = new TextEncoder().encode(value);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return `=?base64?${btoa(binary)}?=`;
}

type ParameterHeader = { name: string; path: string[]; type: "integer" | "string" | "boolean" };
/** An annotation outside a properties-only path is invalid, even inside an unused definition. */
function parameterHeaders(schema: Obj): ParameterHeader[] {
  const found: ParameterHeader[] = [], names = new Set<string>();
  const walk = (value: unknown, path: string[], reachable: boolean, depth: number) => {
    if (depth > 32) fail("Tool schema exceeds nesting limit");
    if (Array.isArray(value)) { for (const v of value) walk(v, path, false, depth + 1); return; }
    if (!object(value)) return;
    if (own(value, "x-mcp-header")) {
      const name = value["x-mcp-header"];
      if (!reachable || !path.length || typeof name !== "string" || !/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(name) || name.length > 128 || names.has(name.toLowerCase()) || !["integer", "string", "boolean"].includes(String(value.type))) fail("Invalid tool parameter header annotation");
      names.add(name.toLowerCase());
      found.push({ name, path, type: value.type as ParameterHeader["type"] });
    }
    for (const [key, child] of Object.entries(value)) {
      if (key === "properties" && object(child)) {
        for (const [name, property] of Object.entries(child)) walk(property, [...path, name], reachable, depth + 1);
      } else if (["$defs", "definitions", "patternProperties", "dependentSchemas"].includes(key) && object(child)) {
        for (const property of Object.values(child)) walk(property, path, false, depth + 1);
      } else if (["items", "prefixItems", "additionalProperties", "contains", "not", "allOf", "oneOf", "anyOf", "if", "then", "else", "propertyNames"].includes(key)) walk(child, path, false, depth + 1);
    }
  };
  walk(schema, [], true, 0);
  return found;
}

type SseEvent = { event: string; data: string; id?: string; retry?: number };
type Bounded = <T>(task: Promise<T>) => Promise<T>;
/** One parser supports LF, CRLF and CR, including delimiters split across network chunks. */
class EventReader {
  private reader: ReadableStreamDefaultReader<Uint8Array>;
  private decoder = new TextDecoder("utf-8", { fatal: true });
  private buffer = "";
  private ended = false;
  private bytes = 0;
  private lines: string[] = [];
  constructor(body: ReadableStream<Uint8Array>, private bounded: Bounded, private account: (n: number) => void, private limit = MCP_MAX_RESPONSE_BYTES) { this.reader = body.getReader(); }
  cancel() { void this.reader.cancel().catch(() => {}); }
  async next(): Promise<SseEvent> {
    for (;;) {
      const newline = /\r\n|\r|\n/.exec(this.buffer);
      if (newline && !(newline[0] === "\r" && newline.index === this.buffer.length - 1 && !this.ended)) {
        const line = this.buffer.slice(0, newline.index);
        this.buffer = this.buffer.slice(newline.index + newline[0].length);
        if (line !== "") { this.lines.push(line); continue; }
        const event: SseEvent = { event: "message", data: "" }, data: string[] = [];
        for (const item of this.lines) {
          const colon = item.indexOf(":"), key = colon < 0 ? item : item.slice(0, colon);
          const value = colon < 0 ? "" : item.slice(colon + 1).replace(/^ /, "");
          if (key === "data") data.push(value);
          else if (key === "event") event.event = value;
          else if (key === "id") {
            if (value.length > 4096 || /[^\x20-\x7e]/.test(value)) fail("Invalid MCP stream event ID");
            event.id = value;
          } else if (key === "retry" && /^\d+$/.test(value)) event.retry = Math.min(Number(value), 2_147_483_647);
        }
        this.lines = [];
        event.data = data.join("\n");
        return event;
      }
      if (this.ended) throw new StreamEnded();
      const { done, value } = await this.bounded(this.reader.read());
      if (done) { this.ended = true; this.buffer += this.decoder.decode(); continue; }
      this.bytes += value.byteLength; this.account(value.byteLength);
      if (this.bytes > this.limit) fail("MCP response exceeds size limit");
      try { this.buffer += this.decoder.decode(value, { stream: true }); } catch { fail("Invalid UTF-8 MCP response"); }
    }
  }
}

type TransportInput = { target: string; headers?: Record<string, string>; transport?: "auto" | "streamable-http" | "sse" };
type SetupStage = "server/discover" | "initialize" | "initialized";
export class McpClient {
  protocolVersion: string | null = null;
  transport: "streamable-http" | "sse" = "streamable-http";
  statusCode?: number;
  modern = false;
  private session: string | null = null;
  private nextId = 0;
  private totalBytes = 0;
  private legacyEvents?: EventReader;
  private postUrl: string;
  private toolHeaders = new Map<string, ParameterHeader[]>();
  constructor(private input: TransportInput, private signal: AbortSignal) { this.postUrl = input.target; }
  private bounded: Bounded = async task => {
    if (this.signal.aborted) { void task.catch(() => {}); return fail("Request timed out"); }
    let abort!: () => void;
    const timed = new Promise<never>((_, reject) => { abort = () => reject(new McpFailure("Request timed out")); this.signal.addEventListener("abort", abort, { once: true }); });
    try { return await Promise.race([task, timed]); }
    finally { this.signal.removeEventListener("abort", abort); }
  };
  private account = (n: number) => { this.totalBytes += n; if (this.totalBytes > MCP_MAX_TOTAL_BYTES) fail("MCP response exceeds size limit"); };
  private headers(method?: string, params?: Obj) {
    const h = new Headers(this.input.headers);
    const remove: string[] = [];
    h.forEach((_, key) => { if (["content-length", "mcp-session-id", "mcp-protocol-version", "last-event-id", "mcp-method", "mcp-name"].includes(key) || key.startsWith("mcp-param-")) remove.push(key); });
    for (const key of remove) h.delete(key);
    h.set("user-agent", checkUserAgent()); h.set("accept", "application/json, text/event-stream"); h.set("content-type", "application/json");
    if (this.session && !this.modern) h.set("mcp-session-id", this.session);
    if (this.protocolVersion) h.set("mcp-protocol-version", this.protocolVersion);
    if (this.modern && method) {
      h.set("mcp-method", method);
      const name = params?.name ?? params?.uri;
      if (["tools/call", "resources/read", "prompts/get"].includes(method) && typeof name === "string") h.set("mcp-name", mcpHeaderValue(name));
      if (method === "tools/call" && typeof params?.name === "string") {
        for (const header of this.toolHeaders.get(params.name) ?? []) {
          let value: unknown = params.arguments;
          for (const segment of header.path) { if (!object(value) || !own(value, segment)) { value = undefined; break; } value = value[segment]; }
          if (value == null) continue;
          if (header.type === "integer" ? !Number.isSafeInteger(value) : typeof value !== header.type) fail("Tool argument cannot be represented by its required MCP header");
          h.set(`mcp-param-${header.name}`, mcpHeaderValue(String(value)));
        }
      }
    }
    return h;
  }
  private async json(res: Response): Promise<unknown> {
    if (!res.body) fail("Empty MCP response");
    const reader = res.body.getReader(), decoder = new TextDecoder("utf-8", { fatal: true });
    let bytes = 0, text = "";
    try {
      for (;;) {
        const { done, value } = await this.bounded(reader.read()); if (done) break;
        bytes += value.byteLength; this.account(value.byteLength);
        if (bytes > MCP_MAX_RESPONSE_BYTES) fail("MCP response exceeds size limit");
        text += decoder.decode(value, { stream: true });
      }
      text += decoder.decode();
      try { return JSON.parse(text); } catch { fail("Invalid JSON in MCP response"); }
    } finally { void reader.cancel().catch(() => {}); }
  }
  private parse(text: string): unknown {
    if (new TextEncoder().encode(text).byteLength > MCP_MAX_RESPONSE_BYTES) fail("MCP response exceeds size limit");
    try { return JSON.parse(text); } catch { return fail("Invalid JSON in MCP response"); }
  }
  private async httpFailure(res: Response, id: number): Promise<never> {
    // Inspect bounded error bodies for modern negotiation errors. Do not copy their arbitrary messages or data.
    if (res.headers.get("content-type")?.split(";")[0].trim().toLowerCase() === "application/json") {
      let raw: unknown;
      try { raw = await this.json(res); } catch (error) { if (error instanceof McpFailure && /size limit|timed out/.test(error.message)) throw error; }
      if (object(raw) && raw.jsonrpc === "2.0" && object(raw.error) && Number.isInteger(raw.error.code)) {
        const versions = object(raw.error.data) && Array.isArray(raw.error.data.supported) ? raw.error.data.supported.filter((v): v is string => typeof v === "string").slice(0, 20) : [];
        if (raw.id === id || raw.id == null) throw new RpcFailure(raw.error.code as number, res.status, versions);
      }
    } else void res.body?.cancel().catch(() => {});
    throw new HttpFailure(res.status);
  }
  private complete(result: Obj): Obj {
    if (this.modern && result.resultType !== "complete") fail(result.resultType === "input_required" ? "MCP request requires interactive input; the probe does not repeat tool calls" : "Invalid modern MCP result type");
    return result;
  }
  private async serverMessage(raw: unknown, id: number, status: number, pings: { count: number }): Promise<Obj | null> {
    if (!this.modern && object(raw) && raw.jsonrpc === "2.0" && raw.method === "ping" && (typeof raw.id === "string" || Number.isInteger(raw.id)) && !own(raw, "result") && !own(raw, "error")) {
      if (++pings.count > 10) fail("MCP server ping limit exceeded");
      const { res } = await this.bounded(guardedFetch(this.postUrl, { method: "POST", headers: this.headers(), signal: this.signal, body: JSON.stringify({ jsonrpc: "2.0", id: raw.id, result: {} }) }, { follow: false, protectBody: true }));
      void res.body?.cancel().catch(() => {});
      if (res.status !== 202) fail("MCP server did not accept the ping response");
      return null;
    }
    const result = responseResult(raw, id, status, true);
    return result === null ? null : this.complete(result);
  }
  async call(method: string, params: Obj = {}, notification = false): Promise<Obj> {
    const id = ++this.nextId;
    const bodyParams = this.modern ? { ...params, _meta: { "io.modelcontextprotocol/protocolVersion": this.protocolVersion, "io.modelcontextprotocol/clientInfo": { name: "OpenUptime", version: "1.0.0" }, "io.modelcontextprotocol/clientCapabilities": {} } } : params;
    let { res } = await this.bounded(guardedFetch(this.postUrl, { method: "POST", headers: this.headers(method, params), signal: this.signal, body: JSON.stringify({ jsonrpc: "2.0", ...(!notification ? { id } : {}), method, params: bodyParams }) }, { follow: false, protectBody: true }));
    this.statusCode = res.status;
    if (!res.ok) return this.httpFailure(res, id);
    if (!this.modern && this.transport === "streamable-http" && method === "initialize") {
      this.session = res.headers.get("mcp-session-id");
      if (this.session !== null && (!this.session.length || this.session.length > 1024 || /[^\x21-\x7e]/.test(this.session))) { void res.body?.cancel().catch(() => {}); fail("Invalid MCP session ID"); }
    }
    if (notification || this.transport === "sse") {
      void res.body?.cancel().catch(() => {});
      if (res.status !== 202) fail("MCP message was not accepted (expected HTTP 202)");
      if (notification) return {};
    }
    if (this.legacyEvents) {
      const pings = { count: 0 };
      for (;;) {
        let event: SseEvent;
        try { event = await this.legacyEvents.next(); } catch (error) { if (error instanceof StreamEnded) fail("Legacy MCP event stream closed before its response"); throw error; }
        if (event.event !== "message" || !event.data) continue;
        const result = await this.serverMessage(this.parse(event.data), id, res.status, pings);
        if (result !== null) return result;
      }
    }
    let lastEventId: string | null = null, retryMs = 1000;
    const pings = { count: 0 };
    for (let resumes = 0; ; resumes++) {
      const mime = res.headers.get("content-type")?.split(";")[0].trim().toLowerCase();
      if (mime === "application/json" && resumes === 0) return this.complete(responseResult(await this.json(res), id, res.status)!);
      if (mime !== "text/event-stream" || !res.body) { void res.body?.cancel().catch(() => {}); fail("Expected JSON or SSE MCP response"); }
      const events = new EventReader(res.body, this.bounded, this.account);
      try {
        for (;;) {
          const event = await events.next();
          if (event.id !== undefined) lastEventId = event.id || null;
          if (event.retry !== undefined) retryMs = event.retry;
          if (!event.data) continue;
          const result = await this.serverMessage(this.parse(event.data), id, res.status, pings);
          if (result !== null) return result;
        }
      } catch (error) {
        if (!(error instanceof StreamEnded) && (error instanceof McpFailure || !networkLevelError(error))) throw error;
        if (this.signal.aborted) fail("Request timed out");
        if (this.modern) fail("Modern MCP stream ended before its response; requests are not retried");
      } finally { events.cancel(); }
      if (!lastEventId) fail("MCP stream ended before its response without a resumable event ID");
      if (resumes >= MCP_MAX_RESUMES) fail("MCP stream resume limit exceeded");
      let timer: ReturnType<typeof setTimeout> | undefined;
      try { await this.bounded(new Promise<void>(resolve => { timer = setTimeout(resolve, retryMs); })); } finally { clearTimeout(timer); }
      const headers = this.headers(); headers.set("accept", "text/event-stream"); headers.delete("content-type"); headers.set("last-event-id", lastEventId);
      ({ res } = await this.bounded(guardedFetch(this.input.target, { method: "GET", headers, signal: this.signal }, { follow: false })));
      this.statusCode = res.status;
      if (!res.ok) { void res.body?.cancel().catch(() => {}); fail(`MCP stream resume returned HTTP ${res.status}`); }
    }
  }
  private async openSse() {
    this.modern = false; this.protocolVersion = null; this.session = null; this.transport = "sse";
    const headers = this.headers(); headers.set("accept", "text/event-stream"); headers.delete("content-type");
    const { res } = await this.bounded(guardedFetch(this.input.target, { method: "GET", headers, signal: this.signal }, { follow: false }));
    this.statusCode = res.status;
    if (!res.ok) return this.httpFailure(res, 0);
    if (res.headers.get("content-type")?.split(";")[0].trim().toLowerCase() !== "text/event-stream" || !res.body) { void res.body?.cancel().catch(() => {}); fail("Expected legacy MCP event stream"); }
    this.legacyEvents = new EventReader(res.body, this.bounded, this.account, MCP_MAX_TOTAL_BYTES);
    for (;;) {
      let event: SseEvent;
      try { event = await this.legacyEvents.next(); } catch (error) { if (error instanceof StreamEnded) fail("Legacy MCP stream ended before its endpoint"); throw error; }
      if (!event.data && event.event === "message") continue;
      if (event.event !== "endpoint" || !event.data || event.data.length > 2048) fail("Invalid legacy MCP endpoint event");
      let endpoint: URL;
      try { endpoint = new URL(event.data, this.input.target); } catch { fail("Invalid legacy MCP endpoint URL"); }
      if (endpoint.origin !== new URL(this.input.target).origin || endpoint.username || endpoint.password || endpoint.hash) fail("Legacy MCP message endpoint must remain on the configured origin");
      this.postUrl = endpoint.href;
      return;
    }
  }
  async connect(stage: <T>(name: SetupStage, run: () => Promise<T>) => Promise<T>): Promise<Obj> {
    if (this.input.transport !== "sse") {
      this.modern = true; this.protocolVersion = MODERN_MCP_VERSION;
      try {
        const discovery = await stage("server/discover", () => this.call("server/discover"));
        if (!Array.isArray(discovery.supportedVersions) || !discovery.supportedVersions.includes(MODERN_MCP_VERSION) || !object(discovery.capabilities)) fail("Invalid or unsupported MCP server discovery");
        return discovery.capabilities;
      } catch (error) {
        const advertisedLegacy = error instanceof RpcFailure && error.code === -32022 ? MCP_PROTOCOL_VERSIONS.slice(1).find(version => error.supported.includes(version)) : undefined;
        if (!advertisedLegacy && !fallbackError(error)) throw error;
        this.modern = false; this.protocolVersion = null; this.nextId = 0;
      }
    } else await stage("initialize", () => this.openSse());
    let init: Obj;
    const initialize = () => this.call("initialize", { protocolVersion: this.transport === "sse" ? "2024-11-05" : "2025-11-25", capabilities: {}, clientInfo: { name: "OpenUptime", version: "1.0.0" } });
    try { init = await stage("initialize", initialize); }
    catch (error) {
      if (this.input.transport === "streamable-http" || this.transport === "sse" || !fallbackError(error)) throw error;
      await stage("initialize", () => this.openSse()); this.nextId = 0;
      init = await stage("initialize", initialize);
    }
    if (typeof init.protocolVersion !== "string" || !(MCP_PROTOCOL_VERSIONS.slice(1) as readonly string[]).includes(init.protocolVersion)) fail("Unsupported MCP protocol version");
    if (!object(init.capabilities)) fail("Invalid MCP server capabilities");
    if (!object(init.serverInfo) || typeof init.serverInfo.name !== "string" || typeof init.serverInfo.version !== "string") fail("Invalid MCP server information");
    this.protocolVersion = init.protocolVersion;
    await stage("initialized", () => this.call("notifications/initialized", {}, true));
    return init.capabilities;
  }
  registerTool(name: string, inputSchema: Obj): boolean {
    if (!this.modern) return true;
    try { this.toolHeaders.set(name, parameterHeaders(inputSchema)); return true; } catch (error) { if (error instanceof McpFailure) return false; throw error; }
  }
  async close() {
    this.legacyEvents?.cancel();
    if (!this.session || this.signal.aborted || this.modern || this.transport === "sse") return;
    try {
      const { res } = await this.bounded(guardedFetch(this.input.target, { method: "DELETE", headers: this.headers(), signal: this.signal }, { follow: false }));
      void res.body?.cancel().catch(() => {});
    } catch { /* Session cleanup is best effort and bounded by the original deadline. */ }
  }
}
