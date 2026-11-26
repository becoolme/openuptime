import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { Monitor } from "../lib/api";
import { acceptsSeveral, MonitorForm } from "./Monitors";

const render = (m: Partial<Monitor>) =>
  renderToStaticMarkup(createElement(MonitorForm, { monitor: { id: "fixture", name: "API", type: "http", target: "https://example.com", method: "GET", expectedStatus: 200, jsonAssertions: [{ path: "$.ok", op: "equals", value: "true" }], ...m } as Monitor, onClose() {}, onSaved() {} }));
const LABEL = 'aria-label="Only when the status is"';

describe("the status limit on a JSON assertion", () => {
  it("is hidden while the monitor expects one status", () => {
    expect(render({})).not.toContain(LABEL);
    expect(render({ expectedStatus: 204 })).not.toContain(LABEL);
  });
  it("is hidden for a custom list that is a single code", () => {
    expect(render({ acceptedStatuses: "200" })).not.toContain(LABEL);
  });
  it("shows for a list that accepts several statuses", () => {
    expect(render({ acceptedStatuses: "200,429" })).toContain(LABEL);
    expect(render({ acceptedStatuses: "2xx" })).toContain(LABEL);
  });
  it("still shows an assertion's saved limit so it can be cleared", () => {
    expect(render({ jsonAssertions: [{ path: "$.ok", op: "exists", value: "", status: "2xx" }] })).toContain(LABEL);
  });
  it("tells a single code from a list", () => {
    expect(["200", " 404 "].map(acceptsSeveral)).toEqual([false, false]);
    expect(["200,429", "200-299", "2xx", "!5xx"].map(acceptsSeveral)).toEqual([true, true, true, true]);
  });
});
