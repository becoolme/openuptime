import { describe, expect, it } from "vitest";
import { mcpObservationSchema } from "./mcp-config";

const observation = (description: string) => ({ stage: "complete", timings: {}, tools: [{ name: "lookup", inputSchema: { type: "object" }, description }], changes: [] });
describe("MCP probe observation limits", () => {
  it("accepts descriptions beyond 16 KiB within the protocol's 1 MiB limit", () => {
    expect(mcpObservationSchema.safeParse(observation("x".repeat(32 * 1024))).success).toBe(true);
    expect(mcpObservationSchema.safeParse(observation("x".repeat(1024 * 1024))).success).toBe(true);
    expect(mcpObservationSchema.safeParse(observation("x".repeat(1024 * 1024 + 1))).success).toBe(false);
  });
  it("enforces description bytes rather than only JavaScript character count", () => {
    expect(mcpObservationSchema.safeParse(observation("中".repeat(350_000))).success).toBe(false);
    expect(mcpObservationSchema.safeParse(observation("中".repeat(300_000))).success).toBe(true);
  });
  it("bounds the entire serialized observation including schema and drift metadata", () => {
    const value = observation("short");
    value.tools[0].inputSchema = { type: "object", ...{ large: "x".repeat(4 * 1024 * 1024) } };
    const parsed = mcpObservationSchema.safeParse(value);
    expect(parsed.success).toBe(false);
    if (!parsed.success) expect(parsed.error.issues.some(issue => issue.message.includes("4 MiB"))).toBe(true);
  });
});
