import { describe, expect, it } from "vitest";
import { publicBody, toPublic } from "./routes/status";

describe("public incident bodies", () => {
  it("hides raw errors of automatic updates but keeps authored text", () => {
    const base = { id: "1", incidentId: "i", createdAt: new Date(), visibility: "public" as const, status: "investigating" as const };
    expect(publicBody({ ...base, authorId: null, body: "3 consecutive failed checks. connect ECONNREFUSED 10.0.0.5:5432" })).not.toMatch(/10\.0\.0\.5/);
    expect(publicBody({ ...base, authorId: "u1", body: "Database failover in progress" })).toBe("Database failover in progress");
    expect(publicBody({ ...base, authorId: null, status: "resolved" as never, body: "Checks are passing again." })).toBe("Checks are passing again.");
  });

  it("drops internal updates and holds back the write-up until the incident is resolved", () => {
    const up = (id: string, body: string, visibility: "public" | "internal") => ({ id, incidentId: "i", createdAt: new Date(), status: "identified" as const, body, authorId: "u1", visibility });
    const inc = {
      id: "i", organizationId: "o", monitorId: null, projectId: "p", number: 7, title: "T", status: "identified" as const, severity: "major" as const, auto: false, assigneeId: "u1",
      startedAt: new Date(), acknowledgedAt: null, resolvedAt: null, evaluationNote: null, nextReminderAt: null, reminderCount: 0, escalationLevel: 0, nextEscalationAt: null,
      rootCause: "disk full", postmortem: "long text", updates: [up("1", "shown", "public"), up("2", "hidden", "internal")],
    };
    const open = toPublic(inc);
    expect(open.updates.map((u) => u.body)).toEqual(["shown"]);
    expect(open).toMatchObject({ number: 7 });
    expect(open).not.toHaveProperty("rootCause");
    expect(open).not.toHaveProperty("postmortem");
    expect(JSON.stringify(open)).not.toContain("hidden");
    expect(toPublic({ ...inc, status: "resolved", resolvedAt: new Date() })).toMatchObject({ rootCause: "disk full", postmortem: "long text" });
  });
});
