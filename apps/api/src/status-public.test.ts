import { describe, expect, it } from "vitest";
import { publicBody } from "./routes/status";

describe("public incident bodies", () => {
  it("hides raw errors of automatic updates but keeps authored text", () => {
    const base = { id: "1", incidentId: "i", createdAt: new Date(), status: "investigating" as const };
    expect(publicBody({ ...base, authorId: null, body: "3 consecutive failed checks. connect ECONNREFUSED 10.0.0.5:5432" })).not.toMatch(/10\.0\.0\.5/);
    expect(publicBody({ ...base, authorId: "u1", body: "Database failover in progress" })).toBe("Database failover in progress");
    expect(publicBody({ ...base, authorId: null, status: "resolved" as never, body: "Checks are passing again." })).toBe("Checks are passing again.");
  });
});
