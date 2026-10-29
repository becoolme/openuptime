import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { Monitor } from "../lib/api";
import { MonitorForm } from "./Monitors";

function render(requestBody: string, method = "POST") {
  const monitor = { id: "fixture", name: "API", type: "http", target: "https://example.com", method, requestBody } as Monitor;
  return renderToStaticMarkup(createElement(MonitorForm, { monitor, onClose() {}, onSaved() {} }));
}

describe("request body byte limit in the monitor form", () => {
  it("counts CJK bytes and disables saving an oversized body", () => {
    const valid = render("你".repeat(5461));
    expect(valid).toContain("16383 / 16384 UTF-8 bytes");
    expect(valid).not.toMatch(/class="btn primary" disabled/);
    const oversized = render("你".repeat(5462));
    expect(oversized).toContain("16386 / 16384 UTF-8 bytes");
    expect(oversized).toMatch(/class="btn primary" disabled/);
    expect(oversized).toContain('aria-invalid="true"');
  });
  it("accepts an emoji body exactly at the byte boundary", () => {
    const html = render("😀".repeat(4096));
    expect(html).toContain("16384 / 16384 UTF-8 bytes");
    expect(html).not.toMatch(/class="btn primary" disabled/);
  });
  it("does not block a method whose request body will be omitted", () => {
    expect(render("你".repeat(5462), "GET")).not.toMatch(/class="btn primary" disabled/);
  });
});
