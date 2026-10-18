import { describe, expect, it } from "vitest";
import { deliveryReason, deliveryState, stateClass } from "./delivery";

const base = { kind: "incident.opened", status: null, ok: false, error: null, statusMessage: null };

describe("deliveryState", () => {
  it("prefers the stored status", () => expect(deliveryState({ ...base, status: "pending", ok: true })).toBe("pending"));
  it("reads legacy rows through ok and error", () => {
    expect(deliveryState({ ...base, ok: true })).toBe("sent");
    expect(deliveryState({ ...base, error: "HTTP 500" })).toBe("failed");
    expect(deliveryState({ ...base, error: "skipped: email allowance used up" })).toBe("skipped");
  });
  it("shows muted alerts as muted", () => expect(deliveryState({ ...base, kind: "incident.muted", status: "skipped" })).toBe("muted"));
});

describe("deliveryReason", () => {
  it("is empty for a sent delivery", () => expect(deliveryReason({ ...base, status: "sent", ok: true })).toBeNull());
  it("explains skips and failures", () => {
    expect(deliveryReason({ ...base, status: "skipped", statusMessage: "skipped: channel disabled" })).toBe("skipped: channel disabled");
    expect(deliveryReason({ ...base, error: "HTTP 500" })).toBe("HTTP 500");
  });
  it("colors only the two outcomes", () => {
    expect(stateClass("sent")).toBe("up");
    expect(stateClass("failed")).toBe("down");
    expect(stateClass("skipped")).toBe("");
  });
});
