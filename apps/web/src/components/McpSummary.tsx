import { useState } from "react";
import type { McpToolSchema, Monitor } from "../lib/api";
import { t } from "../lib/i18n";
import { McpToolCatalog } from "./McpFields";

export function McpSchemaComparison({ baseline, current }: { baseline: McpToolSchema[] | null | undefined; current: McpToolSchema[] }) {
  return <details style={{ marginTop: 12 }}><summary>{t("Compare approved and discovered schemas")}</summary>
    <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))", gap: 12 }}>
      <div><b>{t("Approved baseline")}</b><pre style={{ maxHeight: 360, overflow: "auto", whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{JSON.stringify(baseline ?? [], null, 2)}</pre></div>
      <div><b>{t("Discovered version")}</b><pre style={{ maxHeight: 360, overflow: "auto", whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{JSON.stringify(current, null, 2)}</pre></div>
    </div>
  </details>;
}

export function McpSummary({ monitor: m, onAccept, busy }: { monitor: Monitor; onAccept: (observationId: string, schemaHash: string) => void; busy: boolean }) {
  const [reviewedVersion, setReviewedVersion] = useState<string | null>(null);
  if (m.mcpConfigRedacted) return <div className="card" style={{ padding: 16, marginBottom: 16 }}>{t("Only owners and admins can view or edit MCP connection and tool settings.")}</div>;
  const observation = m.mcpObservation;
  const version = observation?.id && observation.schemaHash ? `${observation.id}:${observation.schemaHash}` : null;
  const drift = observation?.drift ?? [];
  return <div className="card" style={{ padding: 16, marginBottom: 16 }}>
    <strong>{t("MCP discovery and tool health")}</strong>
    {observation ? <>
      <p>{t("Last stage")}: <code>{observation.stage}</code> · {t("Discovered tools")}: {observation.tools.length}</p>
      <p className="muted mono">{observation.checkedAt ?? ""} {observation.transport ?? ""} {observation.protocolVersion ?? ""}</p>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 8 }}>{Object.entries(observation.timings).map(([stage, ms]) => <span className="chip mono" key={stage}>{stage}: {ms} ms</span>)}</div>
      {drift.length > 0 ? <><p>{t("Schema changes")}</p><ul>{drift.map((change, i) => <li key={i}><span className={`chip ${change.severity === "breaking" ? "err" : ""}`}>{t(change.severity)}</span> <code>{change.tool}{change.path ?? ""}</code> {change.message}</li>)}</ul></> : observation.changes.length > 0 && <><p className="err">{t("Breaking schema changes")}</p><ul>{observation.changes.map((change, i) => <li key={i}>{change}</li>)}</ul></>}
      <McpToolCatalog tools={observation.tools} />
      {observation.prompts && <details><summary>{t("Discovered prompts")} ({observation.prompts.length})</summary><ul>{observation.prompts.map((prompt) => <li key={prompt.name}><code>{prompt.name}</code></li>)}</ul></details>}
      {observation.resources && <details><summary>{t("Discovered resources")} ({observation.resources.length})</summary><ul>{observation.resources.map((resource) => <li key={resource.uri}>{resource.name} <code>{resource.uri}</code></li>)}</ul></details>}
    </> : <p className="muted">{t("No MCP discovery recorded yet.")}</p>}
    <p>{t("Required tools")}: {m.mcpConfig?.requiredTools.join(", ") || t("None")}</p>
    <p>{t("Repeated tool calls")}: {m.mcpConfig?.toolCall?.enabled ? m.mcpConfig.toolCall.name : t("Disabled")}</p>
    {m.mcpConfig?.toolCall?.enabled && <p className="muted">{t("Check now also calls the configured tool and may incur charges or write data.")}</p>}
    {m.mcpConfig?.schemaCheck && <>
      <p>{t("Schema baseline")}: {m.mcpBaseline ? `${m.mcpBaseline.length} ${t("tools")}` : t("Waiting for a successful check")}</p>
      {observation && <McpSchemaComparison baseline={m.mcpBaseline} current={observation.tools} />}
      {observation?.toolsComplete && version && <div style={{ marginTop: 12 }}>
        <p className="muted">{t("Accept only the exact version reviewed below. A newer discovery requires another review; accepting does not call a tool.")}</p>
        <p className="mono" style={{ overflowWrap: "anywhere" }}>{observation.schemaHash}</p>
        <label><input type="checkbox" checked={reviewedVersion === version} onChange={(e) => setReviewedVersion(e.target.checked ? version : null)} /> {t("I reviewed this discovered schema version")}</label>
        <div style={{ marginTop: 8 }}><button className="btn sm" disabled={busy || reviewedVersion !== version} onClick={() => onAccept(observation.id!, observation.schemaHash!)}>{t("Accept reviewed schema version")}</button></div>
      </div>}
    </>}
  </div>;
}
