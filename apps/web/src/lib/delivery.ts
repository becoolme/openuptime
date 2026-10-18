import type { AlertDelivery } from "./api";

export type DeliveryState = "pending" | "sending" | "sent" | "failed" | "skipped" | "muted";

/** The state of a delivery row. Rows written before delivery states existed carry only `ok` and `error`. */
export function deliveryState(d: Pick<AlertDelivery, "kind" | "status" | "ok" | "error">): DeliveryState {
  if (d.kind === "incident.muted") return "muted";
  if (d.status) return d.status;
  if (d.error?.startsWith("skipped:")) return "skipped";
  return d.ok ? "sent" : "failed";
}

/** The pill class for a state. */
export const stateClass = (s: DeliveryState): string => (s === "sent" ? "up" : s === "failed" ? "down" : "");

/** The reason a delivery did not go out as asked, in the words stored with it, or null when it was sent. */
export function deliveryReason(d: Pick<AlertDelivery, "kind" | "status" | "ok" | "error" | "statusMessage">): string | null {
  const s = deliveryState(d);
  if (s === "sent" || s === "sending") return null;
  return d.statusMessage ?? d.error;
}
