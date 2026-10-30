import { afterEach, expect, it, vi } from "vitest";
import { deliver } from "./alerts";
import { buildPayload } from "./apns";
import { sendEmail } from "./email";
vi.mock("./email", async original => ({ ...await original<typeof import("./email")>(), sendEmail: vi.fn() }));
afterEach(() => vi.resetAllMocks());
const base = { incident: { id: "incident", title: "MCP: tool schema changed", startedAt: new Date("2026-10-30T00:00:00Z"), resolvedAt: new Date("2026-10-30T00:01:00Z") },
  monitor: { id: "monitor", name: "MCP", target: "https://mcp.example/mcp", type: "mcp" }, schemaDrift: true as const };

it("labels degraded schema email and clearing without calling them downtime or recovery", async () => {
  for (const lang of ["en", "zh-CN"] as const) for (const kind of ["incident.opened", "incident.resolved"] as const) {
    await deliver({ type: "email", name: "Email", config: { to: "fixture@example.com" } }, { ...base, kind }, "schema changed", lang);
    const sent = vi.mocked(sendEmail).mock.calls.at(-1)![0];
    if (lang === "en") {
      expect(sent.subject).toContain(kind === "incident.opened" ? "tool schema changed" : "tool schema alert cleared");
      expect(sent.text).not.toContain("is down");
      expect(sent.text).not.toContain("has recovered");
      expect(sent.text).not.toContain("Downtime");
    } else {
      expect(sent.subject).toContain(kind === "incident.opened" ? "工具结构发生变化" : "工具结构告警已解除");
      expect(sent.text).not.toContain("宕机");
    }
  }
});

it("keeps schema drift push alerts noncritical and names schema clearing accurately", () => {
  const opened = buildPayload({ ...base, kind: "incident.opened" }, "org", "en", true);
  expect(opened.aps.alert.title).toBe("MCP: tool schema changed");
  expect(opened.aps.sound).toBe("default");
  const resolved = buildPayload({ ...base, kind: "incident.resolved" }, "org", "zh-CN", true);
  expect(resolved.aps.alert.title).toBe("MCP：工具结构告警已解除");
  expect(resolved.aps.alert.body).not.toContain("宕机");
});
