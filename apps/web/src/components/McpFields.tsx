import type { McpAssertion, McpConfig, McpOAuth, McpToolSchema } from "../lib/api";
import { t } from "../lib/i18n";
import Select from "./Select";

export type McpForm = {
  transport: "auto" | "streamable-http" | "sse"; listPrompts: boolean; listResources: boolean; driftPolicy: "down" | "degraded" | "record";
  oauthMode: "none" | McpOAuth["mode"]; oauthIssuer: string; oauthClientId: string; oauthClientSecret: string; oauthRefreshToken: string; oauthScopes: string; oauthResource: string; oauthTokenAuthMethod: "client_secret_basic" | "client_secret_post";
  requiredTools: string; schemaCheck: boolean; callEnabled: boolean; toolName: string; argumentsText: string;
  assertions: { path: string; operator: McpAssertion["operator"]; valueText: string }[];
};
export function initialMcpForm(config?: McpConfig | null): McpForm {
  return {
    transport: config?.transport ?? "auto", listPrompts: config?.listPrompts ?? false, listResources: config?.listResources ?? false, driftPolicy: config?.driftPolicy ?? "down",
    oauthMode: config?.oauth?.mode ?? "none", oauthIssuer: config?.oauth?.issuer ?? "", oauthClientId: config?.oauth?.clientId ?? "", oauthClientSecret: config?.oauth?.clientSecret ?? "", oauthRefreshToken: config?.oauth?.refreshToken ?? "", oauthScopes: config?.oauth?.scopes?.join(" ") ?? "", oauthResource: config?.oauth?.resource ?? "", oauthTokenAuthMethod: config?.oauth?.tokenAuthMethod ?? "client_secret_basic",
    requiredTools: config?.requiredTools.join("\n") ?? "", schemaCheck: config?.schemaCheck ?? false,
    callEnabled: config?.toolCall?.enabled === true, toolName: config?.toolCall?.name ?? "",
    argumentsText: JSON.stringify(config?.toolCall?.arguments ?? {}, null, 2),
    assertions: (config?.toolCall?.assertions ?? []).map((a) => ({ path: a.path, operator: a.operator, valueText: JSON.stringify(a.value ?? null) })),
  };
}
/** Tool discovery is independent of required-name assertions and never authorizes calls. */
export function sameOAuthForm(left: McpForm, right: McpForm): boolean {
  const oauthFields = (value: McpForm) => Object.entries(value).filter(([key]) => key.startsWith("oauth"));
  return JSON.stringify(oauthFields(left)) === JSON.stringify(oauthFields(right));
}
export function mcpDiscoveryConfig(form: McpForm, saved?: { config?: McpConfig | null; initial: McpForm }): McpConfig {
  const config = mcpFormConfig({ ...form, callEnabled: false, argumentsText: "{}", assertions: [], toolName: "", requiredTools: "", schemaCheck: false });
  // Do not invent optional OAuth fields or send a stale token for an untouched saved connection.
  if (saved && sameOAuthForm(form, saved.initial)) config.oauth = saved.config?.oauth ?? null;
  return config;
}
/** Leave an unchanged saved configuration out of PATCH, including disabled calls and legacy defaults. */
export function mcpConfigForSave(form: McpForm, initial?: McpForm): McpConfig | undefined {
  if (initial && JSON.stringify(form) === JSON.stringify(initial)) return undefined;
  const config = mcpFormConfig(form);
  // Scheduled checks can rotate a saved refresh token while this form is open. Omit untouched auth
  // instead of replacing the latest stored credentials with the form's original snapshot.
  if (initial && sameOAuthForm(form, initial)) delete config.oauth;
  return config;
}
export function mcpFormConfig(form: McpForm): McpConfig {
  const requiredTools = [...new Set(form.requiredTools.split(/[\n,，]/).map((n) => n.trim()).filter(Boolean))];
  if (requiredTools.length > 100 || requiredTools.some((name) => name.length > 128)) throw new Error(t("Use at most 100 required tools, each up to 128 characters."));
  const bounded = (config: McpConfig) => {
    if (new TextEncoder().encode(JSON.stringify(config)).byteLength > 16384) throw new Error(t("MCP configuration exceeds 16 KiB."));
    return config;
  };
  const oauth: McpOAuth | null = form.oauthMode === "none" ? null : {
    mode: form.oauthMode, issuer: form.oauthIssuer.trim(), clientId: form.oauthClientId.trim(),
    ...(form.oauthClientSecret ? { clientSecret: form.oauthClientSecret } : {}),
    ...(form.oauthMode === "refresh_token" && form.oauthRefreshToken ? { refreshToken: form.oauthRefreshToken } : {}),
    scopes: form.oauthScopes.split(/\s+/).filter(Boolean), ...(form.oauthResource.trim() ? { resource: form.oauthResource.trim() } : {}), tokenAuthMethod: form.oauthTokenAuthMethod,
  };
  if (oauth?.mode === "client_credentials" && !oauth.clientSecret) throw new Error(t("OAuth client credentials require a client secret."));
  if (oauth && (!oauth.issuer || !oauth.clientId || (oauth.mode === "refresh_token" && !oauth.refreshToken))) throw new Error(t("Complete the OAuth issuer, client ID and refresh token when required."));
  const base = { requiredTools, schemaCheck: form.schemaCheck, transport: form.transport, listPrompts: form.listPrompts, listResources: form.listResources, driftPolicy: form.driftPolicy, oauth };
  if (form.callEnabled && !form.toolName.trim()) throw new Error(t("Choose a tool name before enabling calls."));
  let toolCall: McpConfig["toolCall"] = null;
  try {
    let args: unknown;
    try { args = JSON.parse(form.argumentsText); } catch { throw new Error(t("Tool arguments must be a JSON object.")); }
    if (!args || typeof args !== "object" || Array.isArray(args)) throw new Error(t("Tool arguments must be a JSON object."));
    const assertions = form.assertions.map((a): McpAssertion => {
      if (a.path !== "" && (!a.path.startsWith("/") || /~(?![01])/.test(a.path))) throw new Error(t("Assertion paths must be JSON Pointers starting with /, or empty for the entire result."));
      if (a.operator === "exists") return { path: a.path, operator: a.operator };
      let value: unknown;
      try { value = JSON.parse(a.valueText); } catch { throw new Error(t("Assertion values must be valid JSON. Wrap text in double quotes.")); }
      return { path: a.path, operator: a.operator, value };
    });
    if (form.callEnabled || form.toolName || Object.keys(args).length || assertions.length) {
      toolCall = { enabled: form.callEnabled, name: form.toolName.trim(), arguments: args as Record<string, unknown>, assertions };
    }
  } catch (error) {
    // A malformed unsaved draft must never prevent turning calls off. Saved valid fields round-trip unchanged.
    if (form.callEnabled) throw error;
  }
  try { return bounded({ ...base, toolCall }); }
  catch (error) { if (form.callEnabled) throw error; return bounded({ ...base, toolCall: null }); }
}

export function McpFields({ value, onChange, tools, monthlyCalls = 0 }: { value: McpForm; onChange: (v: McpForm) => void; tools: McpToolSchema[]; monthlyCalls?: number }) {
  const set = <K extends keyof McpForm>(key: K, v: McpForm[K]) => onChange({ ...value, [key]: v });
  return <>
    <p className="muted">{t("Connection negotiation and discovery run on every check. Tools run only after you explicitly enable calls below.")}</p>
    <label className="fld">{t("Required tool names (optional)")}
      <textarea className="in mono" rows={3} value={value.requiredTools} onChange={(e) => set("requiredTools", e.target.value)} placeholder={"search\nget_status"} />
      <span className="muted">{t("One name per line. Every required tool must appear in the complete tool list.")}</span>
    </label>
    <div className="fld"><b>{t("Additional checks (optional)")}</b>
      <label><input type="checkbox" checked={value.listPrompts} onChange={(e) => set("listPrompts", e.target.checked)} /> {t("Discover prompts")}</label>
      <label><input type="checkbox" checked={value.listResources} onChange={(e) => set("listResources", e.target.checked)} /> {t("Discover resources")}</label>
      <small className="muted">{t("Lists advertised prompts and resources without rendering prompts or reading resource contents.")}</small>
      <label><input type="checkbox" checked={value.schemaCheck} onChange={(e) => set("schemaCheck", e.target.checked)} /> {t("Watch for breaking tool schema changes")}</label>
      <small className="muted">{t("Save schemas from the first successful check as a baseline. Review later changes and explicitly accept the exact discovered version when the new contract is intentional.")}</small>
    </div>
    {value.schemaCheck && <label className="fld">{t("When a breaking schema change is found")}
      <Select className="in" value={value.driftPolicy} onChange={(v) => set("driftPolicy", v)} options={[{ value: "down", label: t("Mark down and alert") }, { value: "degraded", label: t("Mark degraded and alert") }, { value: "record", label: t("Record only") }]} />
    </label>}
    <div className="fld">
      <label><input type="checkbox" checked={value.callEnabled} onChange={(e) => set("callEnabled", e.target.checked)} /> {t("Enable repeated tool calls")}</label>
      <small className="muted">{t("Tool calls may incur charges or write data. Enabling this runs the selected tool at every check, including Check now. Use dedicated test credentials and safe test arguments.")}</small>
    </div>
    {value.callEnabled && <>
      <p className="muted">{t("About {n} scheduled tool calls per 30 days across selected regions, plus manual checks.").replace("{n}", monthlyCalls.toLocaleString())}</p>
      <label className="fld">{t("Tool to call")}
        <input className="in mono" required maxLength={128} list="mcp-discovered-tools" value={value.toolName} onChange={(e) => set("toolName", e.target.value)} />
        <datalist id="mcp-discovered-tools">{tools.map((tool) => <option key={tool.name} value={tool.name} />)}</datalist>
        <small className="muted">{t("Enter an exact tool name, or choose one from the latest completed discovery.")}</small>
      </label>
      <label className="fld">{t("Tool arguments (JSON object)")}
        <textarea className="in mono" rows={5} required value={value.argumentsText} onChange={(e) => set("argumentsText", e.target.value)} spellCheck={false} />
      </label>
      <div className="fld"><b>{t("Result assertions (optional)")}</b>
        <small className="muted">{t("isError must never be true. Assertions read the tools/call result using JSON Pointer, for example /structuredContent/ok or /content/0/text.")}</small>
        {value.assertions.map((a, i) => {
          const update = (patch: Partial<typeof a>) => set("assertions", value.assertions.map((item, n) => n === i ? { ...item, ...patch } : item));
          return <fieldset key={i} style={{ border: "1px solid var(--line)", padding: 12, borderRadius: 8, marginTop: 8 }}>
            <legend>{t("Assertion")} {i + 1}</legend>
            <label className="fld">{t("Result path (JSON Pointer)")}<input className="in mono" value={a.path} placeholder="/structuredContent/ok" onChange={(e) => update({ path: e.target.value })} /></label>
            <label className="fld">{t("Assertion operator")}<Select className="in" value={a.operator} onChange={(operator) => update({ operator })} options={[{ value: "equals", label: t("Equals") }, { value: "contains", label: t("Contains") }, { value: "exists", label: t("Exists") }]} /></label>
            {a.operator !== "exists" && <label className="fld">{t("Expected value (JSON)")}<input className="in mono" value={a.valueText} placeholder={'"ok"'} onChange={(e) => update({ valueText: e.target.value })} /></label>}
            <button type="button" className="btn sm" onClick={() => set("assertions", value.assertions.filter((_, n) => n !== i))}>{t("Remove")}</button>
          </fieldset>;
        })}
        <div><button type="button" className="btn sm" disabled={value.assertions.length >= 20} onClick={() => set("assertions", [...value.assertions, { path: "", operator: "exists", valueText: "null" }])}>{t("Add assertion")}</button></div>
      </div>
    </>}
    <a href="/docs/mcp-monitors" target="_blank" rel="noreferrer">{t("MCP monitor guide")}</a>
  </>;
}

export function McpConnectionFields({ value, onChange }: { value: McpForm; onChange: (v: McpForm) => void }) {
  const set = <K extends keyof McpForm>(key: K, next: McpForm[K]) => onChange({ ...value, [key]: next });
  return <>
    <label className="fld">{t("MCP transport")}
      <Select className="in" value={value.transport} onChange={(v) => set("transport", v)} options={[{ value: "auto", label: t("Auto detect") }, { value: "streamable-http", label: "Streamable HTTP" }, { value: "sse", label: t("Legacy HTTP + SSE") }]} />
    </label>
    <label className="fld">{t("MCP authentication")}
      <Select className="in" value={value.oauthMode} onChange={(v) => set("oauthMode", v)} options={[{ value: "none", label: t("Request headers") }, { value: "client_credentials", label: t("OAuth client credentials") }, { value: "refresh_token", label: t("OAuth refresh token") }]} />
    </label>
    {value.oauthMode !== "none" && <>
      <p className="muted">{t("Trust this OAuth issuer explicitly. Its metadata supplies the token endpoint; credentials are used only for that issuer. Tokens are renewed automatically.")}</p>
      <label className="fld">{t("OAuth issuer URL")}<input className="in mono" type="url" required value={value.oauthIssuer} onChange={(e) => set("oauthIssuer", e.target.value)} placeholder="https://auth.example.com" /></label>
      <label className="fld">{t("OAuth client ID")}<input className="in mono" required value={value.oauthClientId} onChange={(e) => set("oauthClientId", e.target.value)} autoComplete="off" /></label>
      <label className="fld">{t(value.oauthMode === "client_credentials" ? "OAuth client secret" : "OAuth client secret (optional)")}<input className="in mono" type="password" required={value.oauthMode === "client_credentials"} value={value.oauthClientSecret} onChange={(e) => set("oauthClientSecret", e.target.value)} autoComplete="off" /></label>
      {value.oauthMode === "refresh_token" && <label className="fld">{t("OAuth refresh token")}<input className="in mono" type="password" required value={value.oauthRefreshToken} onChange={(e) => set("oauthRefreshToken", e.target.value)} autoComplete="off" /></label>}
      <label className="fld">{t("OAuth scopes (space separated)")}<input className="in mono" value={value.oauthScopes} onChange={(e) => set("oauthScopes", e.target.value)} /></label>
      <label className="fld">{t("OAuth resource (optional)")}<input className="in mono" type="url" value={value.oauthResource} onChange={(e) => set("oauthResource", e.target.value)} /></label>
      <label className="fld">{t("OAuth token authentication")}<Select className="in" value={value.oauthTokenAuthMethod} onChange={(v) => set("oauthTokenAuthMethod", v)} options={[{ value: "client_secret_basic", label: "client_secret_basic" }, { value: "client_secret_post", label: "client_secret_post" }]} /></label>
    </>}
  </>;
}

export function mcpConnectionKey(target: string, timeoutMs: number, headers: unknown, form: McpForm, region = "auto"): string {
  const { requiredTools: _required, schemaCheck: _schema, driftPolicy: _policy, callEnabled: _enabled, toolName: _name, argumentsText: _args, assertions: _assertions, ...connection } = form;
  return JSON.stringify({ target, timeoutMs, headers, connection, region });
}

export function McpToolCatalog({ tools, onSelect }: { tools: McpToolSchema[]; onSelect?: (name: string) => void }) {
  if (!tools.length) return null;
  return <div className="fld"><b>{t("Discovered tools")}</b>
    <p className="muted">{t("Tool annotations are server claims, not a safety guarantee. Selecting a tool does not enable calls.")}</p>
    <div style={{ maxHeight: 320, overflow: "auto" }}>{tools.map((tool) => <details key={tool.name} style={{ padding: "8px 0", borderBottom: "1px solid var(--line)" }}>
      <summary><code>{tool.name}</code></summary>
      {tool.description && <p style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{tool.description}</p>}
      {tool.annotations && <div style={{ display: "flex", gap: 6, flexWrap: "wrap", margin: "8px 0" }}>{Object.entries(tool.annotations).map(([name, value]) => <span key={name} className="chip mono">{name}: {String(value)}</span>)}</div>}
      <b>{t("Input schema")}</b><pre style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{JSON.stringify(tool.inputSchema, null, 2)}</pre>
      {tool.outputSchema && <><b>{t("Output schema")}</b><pre style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{JSON.stringify(tool.outputSchema, null, 2)}</pre></>}
      {onSelect && <button type="button" className="btn sm" onClick={() => onSelect(tool.name)}>{t("Select this tool")}</button>}
    </details>)}</div>
  </div>;
}
