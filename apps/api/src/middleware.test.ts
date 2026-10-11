import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import type { AppEnv } from "./env";
import { requireManager } from "./middleware";

const call = async (role: string | null) => {
  const app = new Hono<AppEnv>();
  app.use("*", async (c, next) => {
    c.set("repo", { memberRole: async () => role } as never);
    c.set("userId", "u");
    c.set("orgId", "o");
    await next();
  });
  app.delete("/x", requireManager, (c) => c.body(null, 204));
  app.onError((e, c) => c.json({ error: e.message }, (e as { status?: 403 }).status ?? 500));
  return (await app.request("/x", { method: "DELETE" })).status;
};

describe("requireManager", () => {
  it("lets owners and admins through, not members or outsiders", async () => {
    expect(await call("owner")).toBe(204);
    expect(await call("admin")).toBe(204);
    expect(await call("member")).toBe(403);
    expect(await call(null)).toBe(403);
  });
});
