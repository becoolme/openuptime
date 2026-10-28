import type { Monitor } from "@openuptime/repo";

/** The region every monitor starts with: the check runs from the scheduler itself, no probe involved. */
export const AUTO = "auto";

/** Monitor types a probe can run: they need only an outbound connection and no credentials of ours. */
export const PROBE_TYPES = ["http", "tcp", "websocket"] as const;

/** A region id: what a monitor stores and what `PROBE_REGIONS` is keyed by. Not tied to any hosting provider's codes. */
export const REGION_ID = /^[a-z0-9][a-z0-9-]{1,23}$/;

/** Labels for the ids the bundled probe deploys to, so a bare `"us-east": "https://…"` entry reads well in the UI. */
export const REGION_NAMES: Record<string, string> = {
  "us-east": "US East (Virginia)",
  "us-west": "US West (San Francisco)",
  "eu-central": "Europe (Frankfurt)",
  "ap-southeast": "Asia Pacific (Singapore)",
  "ap-northeast": "Asia Pacific (Tokyo)",
};

/**
 * The regions a monitor's checks run from, in the order stored, without duplicates. `auto` when none is set or when the
 * type cannot be probed remotely (database checks carry no credentials of ours to a third party; heartbeats are not
 * checks of ours at all).
 */
export function effectiveRegions(m: Pick<Monitor, "type" | "regions">): string[] {
  if (!(PROBE_TYPES as readonly string[]).includes(m.type)) return [AUTO];
  const list = [...new Set((m.regions ?? []).filter((r) => typeof r === "string" && r))];
  return list.length ? list : [AUTO];
}
