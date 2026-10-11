import { readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { createDb } from "./client";
import { migrate } from "./migrate";
import { MIGRATIONS } from "./migrations.generated";

describe("embedded migrations", () => {
  it("cover every drizzle SQL file, in journal order", () => {
    const files = readdirSync(new URL("../drizzle/", import.meta.url)).filter((f) => f.endsWith(".sql"));
    expect(MIGRATIONS.map((m) => m.tag).sort()).toEqual(files.map((f) => f.replace(/\.sql$/, "")).sort());
    const whens = MIGRATIONS.map((m) => m.when);
    expect([...whens].sort((a, b) => a - b)).toEqual(whens);
  });
});

const url = process.env.DATABASE_URL;
describe.skipIf(!url)("migrate", () => {
  it("serialises concurrent runs instead of colliding", async () => {
    const db = createDb(url!, { max: 4 });
    const runs = await Promise.allSettled([migrate(db), migrate(db), migrate(db)]);
    expect(runs.map((r) => r.status)).toEqual(["fulfilled", "fulfilled", "fulfilled"]);
    await db.$client.end();
  });
});
