import { describe, expect, it } from "vitest";
import { z } from "zod";
import { renderTemplate, templateProblem, webhookConfig, webhookExtraHeaders, webhookRequest, webhookWants, type WebhookAlert } from "./webhook-config";

const schema = webhookConfig(z.string());
const alert: WebhookAlert = {
  kind: "incident.opened", status: "down", message: 'API "prod" is down\nsince 10:00', incident: { id: "inc-1", title: "Down" },
  monitor: { name: 'API "prod"', target: "https://api.example.com" }, project: { name: "Main" }, url: "https://app.example.com/app/incidents/inc-1",
  payload: { kind: "incident.opened", incident: { id: "inc-1", title: "Down" } },
};

describe("webhook settings", () => {
  it("accepts a plain URL as before", () => {
    expect(schema.parse({ url: "https://example.com" })).toEqual({ url: "https://example.com" });
  });

  it("takes a method, headers, events and a template", () => {
    const v = schema.parse({ url: "u", method: "PUT", headers: { Authorization: "Bearer x" }, events: ["incident.opened", "incident.opened"], template: '{"text":"{{message}}"}' });
    expect(v).toMatchObject({ method: "PUT", headers: { Authorization: "Bearer x" }, events: ["incident.opened"] });
  });

  it("refuses headers OpenUptime sets, bad names, duplicates and control characters", () => {
    for (const headers of [{ "Content-Type": "text/plain" }, { "webhook-signature": "v1,x" }, { Host: "x" }, { "bad name": "x" }, { "X-A": "1", "x-a": "2" }, { "X-A": "a\r\nb" }])
      expect(schema.safeParse({ url: "u", headers }).success).toBe(false);
    expect(schema.safeParse({ url: "u", headers: Object.fromEntries(Array.from({ length: 11 }, (_, i) => [`X-${i}`, "v"])) }).success).toBe(false);
  });

  it("drops an empty header list and an empty template", () => {
    expect(schema.parse({ url: "u", headers: {}, template: "  " })).toEqual({ url: "u" });
  });

  it("refuses an empty event list, a content type without a template and unknown events", () => {
    expect(schema.safeParse({ url: "u", events: [] }).success).toBe(false);
    expect(schema.safeParse({ url: "u", events: ["incident.reminder"] }).success).toBe(false);
    expect(schema.safeParse({ url: "u", contentType: "text/plain" }).success).toBe(false);
  });

  it("checks templates when they are saved", () => {
    expect(templateProblem('{"t":"{{nope}}"}', "application/json")).toMatch(/Unknown placeholder \{\{nope\}\}/);
    expect(templateProblem('{"t":{{message}}}', "application/json")).toMatch(/valid JSON/);
    expect(templateProblem('{"t":"{{message}}","raw":{{payload}}}', "application/json")).toBeNull();
    expect(templateProblem("down: {{monitor.name}}", "text/plain")).toBeNull();
    expect(schema.safeParse({ url: "u", template: "{{message}}" }).success).toBe(false);
    expect(schema.safeParse({ url: "u", template: "{{message}}", contentType: "text/plain; charset=utf-8" }).success).toBe(true);
  });
});

describe("webhook requests", () => {
  it("sends the standard payload with its id by default", () => {
    const r = webhookRequest({ url: "u" }, alert, "row-1");
    expect(r.method).toBe("POST");
    expect(r.contentType).toBe("application/json");
    expect(JSON.parse(r.body)).toEqual({ id: "row-1", ...alert.payload });
  });

  it("fills a JSON template with escaped values and the raw payload", () => {
    const r = webhookRequest({ url: "u", method: "PATCH", template: '{"text":"{{message}}","who":"{{monitor.name}}","s":"{{status}}","full":{{payload}}}' }, alert, "row-1", new Date("2026-01-02T03:04:05Z"));
    expect(r.method).toBe("PATCH");
    expect(JSON.parse(r.body)).toEqual({ text: alert.message, who: 'API "prod"', s: "down", full: { id: "row-1", ...alert.payload } });
  });

  it("leaves values as they are in a non-JSON body", () => {
    expect(renderTemplate("{{ monitor.name }} @ {{timestamp}}", "text/plain", { ...Object.fromEntries(["id", "event", "status", "message", "incident.id", "incident.title", "incident.url", "monitor.target", "project.name", "payload"].map((k) => [k, ""])), "monitor.name": 'A "b"', timestamp: "T" } as never)).toBe('A "b" @ T');
  });

  it("filters by event and keeps only safe stored headers", () => {
    expect(webhookWants({}, "incident.resolved")).toBe(true);
    expect(webhookWants({ events: ["incident.opened"] }, "incident.resolved")).toBe(false);
    expect(webhookExtraHeaders({ headers: { "X-Key": "k", "Content-Type": "x", n: 1 } })).toEqual({ "X-Key": "k" });
  });
});
