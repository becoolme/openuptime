import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { McpConfig, McpHistory, Monitor } from "../lib/api";
import { initialMcpForm, mcpFormConfig, mcpConfigForSave, mcpDiscoveryConfig, mcpConnectionKey, McpToolCatalog } from "./McpFields";
import { MonitorForm } from "./Monitors";
import { McpSummary } from "./McpSummary";
import { McpTimingChart } from "./McpHistory";
const monitor: Monitor = { method: "GET", expectedStatus: 200, intervalSec: 60, timeoutMs: 10000, failureThreshold: 3, status: "pending", paused: false, lastCheckedAt: null, heartbeatToken: null, id: "mcp-fixture", name: "Agent tools", type: "mcp", target: "https://example.com/mcp", headers: { Authorization: "Bearer test-only" } };
const defaults = { transport: "auto", listPrompts: false, listResources: false, driftPolicy: "down", oauth: null };
const render = (m: Monitor) => renderToStaticMarkup(createElement(MonitorForm, { monitor: m, onClose() {}, onSaved() {} }));
describe("MCP monitor form", () => {
  it("defaults to discovery with both advanced checks off", () => {
    expect(mcpFormConfig(initialMcpForm())).toEqual({ ...defaults, requiredTools: [], schemaCheck: false, toolCall: null });
    const html = render(monitor);
    expect(html).toContain("Required tool names (optional)");
    expect(html).toContain("Enable repeated tool calls");
    expect(html).not.toContain("Tool arguments (JSON object)");
    expect(html).not.toContain('type="checkbox" checked');
    expect(html).toContain("may incur charges or write data");
    expect(html).toContain("Request headers");
  });
  it("drops disabled calls without parsing retained arguments or assertions", () => {
    const f = initialMcpForm(); f.argumentsText = "invalid"; f.toolName = "write"; f.requiredTools = "search\n search,read";
    f.assertions = [{ path: "bad", operator: "equals", valueText: "bad" }];
    expect(mcpFormConfig(f)).toEqual({ ...defaults, requiredTools: ["search", "read"], schemaCheck: false, toolCall: null });
  });
  it("preserves disabled saved calls and omits untouched MCP settings from an unrelated edit", () => {
    const config: McpConfig = { requiredTools: ["read"], schemaCheck: true, toolCall: { enabled: false, name: "read", arguments: { id: 42 }, assertions: [{ path: "/structuredContent/ok", operator: "equals", value: true }] } };
    const initial = initialMcpForm(config);
    expect(mcpConfigForSave({ ...initial }, initial)).toBeUndefined();
    expect(mcpFormConfig(initial)).toEqual({ ...defaults, ...config });
    expect(mcpConfigForSave({ ...initial, schemaCheck: false }, initial)?.toolCall).toEqual(config.toolCall);
    expect(mcpConfigForSave(initialMcpForm(null), initialMcpForm(null))).toBeUndefined();
  });
  it("turns off repeated calls while retaining valid arguments for later re-enabling", () => {
    const config: McpConfig = { requiredTools: [], schemaCheck: true, toolCall: { enabled: true, name: "read", arguments: { environment: "test" }, assertions: [{ path: "/content/0/text", operator: "contains", value: "ok" }] } };
    const initial = initialMcpForm(config);
    const disabled = mcpConfigForSave({ ...initial, callEnabled: false }, initial)!;
    expect(disabled.toolCall).toEqual({ ...config.toolCall, enabled: false });
    expect(mcpFormConfig({ ...initialMcpForm(disabled), callEnabled: true })).toEqual({ ...defaults, ...config });
  });
  it("previews discovery without executing even an enabled destructive call", () => {
    const form = { ...initialMcpForm(), callEnabled: true, toolName: "delete_records", argumentsText: "invalid unsaved draft", requiredTools: "not-yet-known", schemaCheck: true };
    expect(mcpDiscoveryConfig(form)).toEqual({ ...defaults, requiredTools: [], schemaCheck: false, toolCall: null });
  });
  it("retains trusted OAuth and transport settings during discovery without authorizing calls", () => {
    const form = { ...initialMcpForm(), transport: "sse" as const, listPrompts: true, listResources: true, oauthMode: "refresh_token" as const, oauthIssuer: "https://auth.example.com", oauthClientId: "monitor", oauthRefreshToken: "test-refresh", oauthScopes: "read tools", callEnabled: true, toolName: "write", argumentsText: '{"id":1}' };
    const config = mcpDiscoveryConfig(form);
    expect(config.toolCall).toBeNull();
    expect(config.oauth).toMatchObject({ mode: "refresh_token", issuer: "https://auth.example.com", clientId: "monitor", refreshToken: "test-refresh", scopes: ["read", "tools"] });
    expect(config).toMatchObject({ transport: "sse", listPrompts: true, listResources: true });
    const key = mcpConnectionKey("https://example.com", 10000, [], form);
    expect(mcpConnectionKey("https://example.com", 10000, [], { ...form, toolName: "read", callEnabled: false })).toBe(key);
    expect(mcpConnectionKey("https://example.com", 10000, [], { ...form, oauthIssuer: "https://different.example.com" })).not.toBe(key);
  });
  it("previews saved OAuth using its exact optional fields and lets the server supply the current token", () => {
    const original: McpConfig = { requiredTools: [], schemaCheck: false, toolCall: null, oauth: { mode: "refresh_token", issuer: "https://auth.example.com", clientId: "monitor", refreshToken: "old-token" } };
    const initial = initialMcpForm(original);
    expect(initial.oauthRefreshToken).toBe("");
    const preview = mcpDiscoveryConfig({ ...initial, argumentsText: "invalid draft", callEnabled: true }, { config: original, initial });
    expect(preview.oauth).toEqual({ mode: "refresh_token", issuer: "https://auth.example.com", clientId: "monitor" });
    expect(preview.toolCall).toBeNull();
    expect(mcpConfigForSave({ ...initial }, initial)).toBeUndefined();
    expect(() => mcpFormConfig({ ...initialMcpForm(), oauthMode: "client_credentials", oauthIssuer: "https://auth.example.com", oauthClientId: "monitor" })).toThrow("client secret");
    // A new monitor has no stored token to keep.
    expect(() => mcpFormConfig({ ...initialMcpForm(), oauthMode: "refresh_token", oauthIssuer: "https://auth.example.com", oauthClientId: "monitor" })).toThrow("refresh token");
  });
  it("never sends back a refresh token the user did not type, so a rotated one cannot be overwritten", () => {
    // The form was opened while the stored token was r1; a scheduled check has since rotated it to r2.
    const initial = initialMcpForm({ requiredTools: [], schemaCheck: false, toolCall: null, oauth: { mode: "refresh_token", issuer: "https://auth.example.com", clientId: "monitor", refreshToken: "r1" } });
    expect(mcpConfigForSave({ ...initial, requiredTools: "read" }, initial)).not.toHaveProperty("oauth");
    const scopesOnly = mcpConfigForSave({ ...initial, oauthScopes: "read write" }, initial)!;
    expect(scopesOnly.oauth).toMatchObject({ mode: "refresh_token", scopes: ["read", "write"] });
    expect(scopesOnly.oauth).not.toHaveProperty("refreshToken");
    expect(mcpConfigForSave({ ...initial, oauthRefreshToken: "replacement-token" }, initial)?.oauth?.refreshToken).toBe("replacement-token");
    expect(mcpConfigForSave({ ...initial, oauthMode: "none" }, initial)?.oauth).toBeNull();
  });
  it("uses the first selected preview region and invalidates results after a region change", () => {
    const form = initialMcpForm();
    expect(mcpConnectionKey("http://service.internal/mcp", 10000, [], form, "office")).not.toBe(mcpConnectionKey("http://service.internal/mcp", 10000, [], form, "auto"));
    const html = render({ ...monitor, regions: ["office", "backup-office"] });
    expect(html).toContain("Discovery preview region");
    expect(html).toContain("<strong>office</strong>");
    expect(html).toContain("first selected check region");
  });
  it("shows selected-region call volume only after explicit opt-in", () => {
    const html = render({ ...monitor, regions: ["auto", "eu", "us"], intervalSec: 300, mcpConfig: { requiredTools: [], schemaCheck: false, toolCall: { enabled: true, name: "read", arguments: {}, assertions: [] } } });
    expect(html).toContain("25,920 scheduled tool calls");
    expect(html).toContain("Discover tools without calling them");
  });
  it("offers the complete MCP timeout budget and preserves saved millisecond values", () => {
    const html = render({ ...monitor, timeoutMs: 12500 });
    expect(html).toContain("Timeout (ms)");
    expect(html).toMatch(/min="1000" max="30000" step="1"[^>]*value="12500"/);
  });
  it("requires an exact name, object arguments and valid JSON assertion values", () => {
    const f = { ...initialMcpForm(), callEnabled: true };
    expect(() => mcpFormConfig(f)).toThrow("tool name");
    f.toolName = "read"; f.argumentsText = "[]";
    expect(() => mcpFormConfig(f)).toThrow("JSON object");
    f.argumentsText = '{"id":1}'; f.assertions = [{ path: "/structuredContent/ok", operator: "equals", valueText: "true" }];
    expect(mcpFormConfig(f).toolCall).toEqual({ enabled: true, name: "read", arguments: { id: 1 }, assertions: [{ path: "/structuredContent/ok", operator: "equals", value: true }] });
    f.assertions[0].valueText = "ok";
    expect(() => mcpFormConfig(f)).toThrow("valid JSON");
  });
  it("hides redacted configuration and disables the target", () => {
    const html = render({ ...monitor, mcpConfigRedacted: true });
    expect(html).toContain("Only owners and admins");
    expect(html).not.toContain("Enable repeated tool calls");
    expect(html).not.toContain("Bearer test-only");
    expect(html).toMatch(/disabled=""[^>]*value="https:\/\/example.com\/mcp"/);
  });
});
describe("MCP diagnostics", () => {
  it("shows server annotations as untrusted hints and safely renders tool descriptions", () => {
    const html = renderToStaticMarkup(createElement(McpToolCatalog, { tools: [{ name: "read", inputSchema: { type: "object" }, description: "<script>unsafe</script>", annotations: { readOnlyHint: true, destructiveHint: false } }], onSelect() {} }));
    expect(html).toContain("not a safety guarantee");
    expect(html).toContain("readOnlyHint: true");
    expect(html).toContain("&lt;script&gt;unsafe&lt;/script&gt;");
    expect(html).not.toContain("<script>");
  });
  it("shows old and new schemas and requires review before accepting an exact version", () => {
    const html = renderToStaticMarkup(createElement(McpSummary, { monitor: { ...monitor, mcpConfig: { requiredTools: [], schemaCheck: true, toolCall: null }, mcpBaseline: [{ name: "read", inputSchema: { type: "string" } }], mcpObservation: { id: "version-2", schemaHash: "hash-2", toolsComplete: true, stage: "schema", timings: {}, tools: [{ name: "read", inputSchema: { type: "number" } }], changes: [], drift: [{ severity: "breaking", kind: "type", tool: "read", message: "type changed" }] } }, onAccept() {}, busy: false }));
    expect(html).toContain("Approved baseline"); expect(html).toContain("Discovered version");
    expect(html).toContain("string"); expect(html).toContain("number");
    expect(html).toContain("hash-2");
    expect(html).toMatch(/disabled="">Accept reviewed schema version/);
    expect(html).not.toContain("Reset schema baseline");
  });
  it("renders historical stage timings separately from overall latency", () => {
    const rows: McpHistory["results"] = [{ id: "run", checkedAt: "2026-10-30T12:00:00Z", ok: true, statusCode: 200, latencyMs: 500, error: null, region: "eu", mcp: { stage: "complete", timings: { initialize: 20, "tools/list": 80 }, changes: [] } }];
    const html = renderToStaticMarkup(createElement(McpTimingChart, { rows, stage: "tools/list" }));
    expect(html).toContain("80 ms"); expect(html).not.toContain("500 ms");
    expect(renderToStaticMarkup(createElement(McpTimingChart, { rows, stage: "tools/call" }))).toContain("No timings for this stage.");
  });
  it("shows the failed stage, timings and escaped schema changes without call arguments", () => {
    const html = renderToStaticMarkup(createElement(McpSummary, { monitor: { ...monitor, mcpObservation: { stage: "schema", timings: { initialize: 12, "tools/list": 30 }, tools: [], changes: ["Tool <script> removed"] } }, onAccept() {}, busy: false }));
    expect(html).toContain("<code>schema</code>");
    expect(html).toContain("tools/list: 30 ms");
    expect(html).toContain("Tool &lt;script&gt; removed");
    expect(html).not.toContain("Bearer test-only");
  });
});
