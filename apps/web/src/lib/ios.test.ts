import { describe, expect, it } from "vitest";
import { iosInstall } from "./ios";

describe("iosInstall", () => {
  it("is coming soon without a link", () => {
    expect(iosInstall("").kind).toBe("soon");
  });
  it("tells TestFlight from the App Store", () => {
    expect(iosInstall("https://testflight.apple.com/join/abc").kind).toBe("testflight");
    expect(iosInstall("https://apps.apple.com/app/id1").kind).toBe("appstore");
  });
});
