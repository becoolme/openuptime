import type { Database, OpenDatabase } from "@openuptime/repo";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { createDb } from "./client";
import { migrate } from "./migrate";
import { createRepo } from "./repo";
import * as schema from "./schema";

export * from "drizzle-orm";
export { createDb, type Db } from "./client";
export { createRepo } from "./repo";
export { migrate } from "./migrate";
export * as schema from "./schema";

/** The Postgres backend: opens one connection pool and exposes it as a `Database`. */
export const openDatabase: OpenDatabase = (connectionString, opts) => {
  const db = createDb(connectionString, opts);
  const database: Database = {
    repo: createRepo(db),
    authDatabase: drizzleAdapter(db, { provider: "pg", schema }),
    migrate: () => migrate(db),
    close: (timeoutSec = 1) => db.$client.end({ timeout: timeoutSec }),
  };
  return database;
};
