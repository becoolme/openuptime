import type { Repo } from "@openuptime/repo";
import { Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { purgePublicStatus } from "./routes/status";
import { incidents } from "./routes/incidents";

vi.mock("./routes/status", () => ({ purgePublicStatus: vi.fn() }));
vi.mock("./alerts", () => ({ notifyIncidentUpdate: vi.fn(async () => {}) }));

const ID = "7d4f3a52-1b0c-4b8e-9d34-2a6f5c1e8b90";
const inc = { id: ID, organizationId: "org", title: "T", monitorId: null, projectId: "p" };

function app() {
  const repo = {
    incidentVisible: async () => true,
    updateIncidentWriteUp: async () => inc,
    createIncident: async () => inc,
    postIncidentUpdate: async () => ({ incident: inc, update: { id: "u", visibility: "public" } }),
  } as unknown as Repo;
  return new Hono()
    .use("*", async (c, next) => {
      c.set("repo" as never, repo as never);
      c.set("orgId" as never, "org" as never);
      c.set("projectId" as never, "p" as never);
      c.set("userId" as never, "u" as never);
      await next();
    })
    .route("/incidents", incidents as never);
}
const send = (method: string, path: string, body: unknown) =>
  app().request(`/incidents${path}`, { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

describe("incident writes refresh the public status page", () => {
  beforeEach(() => vi.mocked(purgePublicStatus).mockClear());

  it("purges after publishing or taking down a postmortem", async () => {
    expect((await send("PATCH", `/${ID}`, { publishPostmortem: false })).status).toBe(200);
    expect(purgePublicStatus).toHaveBeenCalledTimes(1);
  });

  it("purges after a new incident and after a posted update", async () => {
    expect((await send("POST", "", { title: "Down" })).status).toBe(201);
    expect((await send("POST", `/${ID}/updates`, { status: "resolved", body: "Fixed" })).status).toBe(201);
    expect(purgePublicStatus).toHaveBeenCalledTimes(2);
  });

  it("does not purge when the incident is not found", async () => {
    const missing = new Hono()
      .use("*", async (c, next) => { c.set("repo" as never, { incidentVisible: async () => false } as never); c.set("orgId" as never, "org" as never); await next(); })
      .route("/incidents", incidents as never);
    expect((await missing.request(`/incidents/${ID}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ publishPostmortem: true }) })).status).toBe(404);
    expect(purgePublicStatus).not.toHaveBeenCalled();
  });
});
