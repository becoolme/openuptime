import { describe, expect, it } from "vitest";
import { everyShort } from "./api";

describe("everyShort", () => {
  it.each([[30, "30s"], [60, "1m"], [300, "5m"], [2700, "45m"], [3600, "1h"], [7200, "2h"], [86400, "1d"], [90, "90s"], [5400, "90m"]])("%i s is %s", (sec, out) => {
    expect(everyShort(sec)).toBe(out);
  });
});
