import { describe, expect, it } from "vitest";
import { countLabel } from "./plural";

describe("countLabel", () => {
  it("uses the singular for exactly one", () => {
    expect(countLabel("en", 1, "monitor", "monitors")).toBe("1 monitor");
    expect(countLabel("en", 0, "monitor", "monitors")).toBe("0 monitors");
    expect(countLabel("en", 2, "open incident", "open incidents")).toBe("2 open incidents");
    expect(countLabel("en", 1, "open incident", "open incidents")).toBe("1 open incident");
  });
  it("reads the same for every count in Chinese", () => {
    expect(countLabel("zh-CN", 1, "monitor", "monitors")).toBe("1 个监控");
    expect(countLabel("zh-CN", 5, "monitor", "monitors")).toBe("5 个监控");
    expect(countLabel("zh-CN", 1, "open incident", "open incidents")).toBe("1 个未解决事件");
  });
});
