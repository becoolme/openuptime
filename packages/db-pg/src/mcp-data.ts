import type { McpConfig, McpObservation, McpToolSchema } from "@openuptime/repo";
export function completeMcpDiscovery(observation: McpObservation): boolean {
  if (observation.toolsComplete !== undefined) return observation.toolsComplete;
  return ["required-tools", "schema", "tools/call", "assertions", "complete"].includes(observation.stage);
}
export async function mcpSchemaHash(tools: McpToolSchema[]): Promise<string> {
  const text = JSON.stringify([...tools].sort((a, b) => a.name.localeCompare(b.name)), (_key, value) =>
    value && typeof value === "object" && !Array.isArray(value) ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b))) : value);
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(hash)].map(byte => byte.toString(16).padStart(2, "0")).join("");
}

/** Defaults and disabled drafts do not change the checks actually performed. */
export function comparableMcpConfig(config: McpConfig | null | undefined): unknown {
  return {
    requiredTools: [...new Set(config?.requiredTools ?? [])].sort(), schemaCheck: config?.schemaCheck ?? false,
    transport: config?.transport ?? "auto", listPrompts: config?.listPrompts ?? false, listResources: config?.listResources ?? false,
    driftPolicy: config?.driftPolicy ?? "down", oauth: config?.oauth ?? null,
    toolCall: config?.toolCall?.enabled === true ? { ...config.toolCall, assertions: config.toolCall.assertions.map(assertion =>
      assertion.operator === "exists" ? { path: assertion.path, operator: assertion.operator } : assertion) } : null,
  };
}

/** Namespaced deterministic UUID links one recipient task to exactly one delivery log across retries. */
export async function mcpTaskId(eventKey: string, recipient: string): Promise<string> {
  const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(["openuptime:mcp-alert", eventKey, recipient]))));
  hash[6] = (hash[6] & 0x0f) | 0x50;
  hash[8] = (hash[8] & 0x3f) | 0x80;
  const h = [...hash.slice(0, 16)].map(value => value.toString(16).padStart(2, "0")).join("");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}
