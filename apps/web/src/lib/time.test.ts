import { describe, expect, it } from "vitest";
import { fmtDateTime, fmtTime } from "./time";

const at = "2026-11-03T14:05:09Z";
// the output follows the browser locale, so the assertions pin one instead of assuming the machine's
const en = { locale: "en-US" } as const;

describe("clock times", () => {
  it("follows the 12- or 24-hour choice", () => {
    expect(fmtTime(at, { ...en, utc: true, clock: "24" })).toMatch(/^14:05 UTC$/);
    expect(fmtTime(at, { ...en, utc: true, clock: "12" })).toMatch(/^0?2:05\s?PM UTC$/i);
    expect(fmtTime(at, { ...en, utc: true, seconds: true, clock: "24" })).toMatch(/^14:05:09 UTC$/);
    expect(fmtDateTime(at, { ...en, timeZone: "UTC", clock: "24" })).toContain("14:05");
    expect(fmtDateTime(at, { ...en, timeZone: "UTC", clock: "12" })).toMatch(/2:05\s?PM/i);
  });
  it("keeps UTC and log-column times on a 24-hour clock unless 12 hours was chosen", () => {
    expect(fmtTime(at, { ...en, utc: true, clock: "auto" })).toMatch(/^14:05 UTC$/);
    expect(fmtTime(at, { ...en, auto24: true, clock: "auto" })).not.toMatch(/[AP]M/i);
  });
  it("shows midnight as 00 on a 24-hour clock", () => {
    expect(fmtTime("2026-11-03T00:05:00Z", { ...en, utc: true, clock: "24" })).toBe("00:05 UTC");
    expect(fmtDateTime("2026-11-03T00:05:00Z", { ...en, timeZone: "UTC", clock: "24" })).toContain("00:05");
  });
  it("shows a dash for a time it cannot read", () => {
    expect(fmtTime("not a date")).toBe("—");
  });
});
