import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema";

/**
 * Works on Cloudflare Workers (pass the Hyperdrive connection string) and in Node.
 * `prepare: false` keeps it compatible with pgbouncer / Hyperdrive; `fetch_types: false` skips a pg_type lookup
 * that would cost one extra round trip on every new connection (one per request on Workers).
 * One client per request on Workers — Hyperdrive does the real pooling.
 */
export function createDb(connectionString: string, opts: { max?: number } = {}) {
  const client = postgres(connectionString, { prepare: false, fetch_types: false, max: opts.max ?? 5 });
  return Object.assign(drizzle(client, { schema }), { $client: client });
}
export type Db = ReturnType<typeof createDb>;

/** Query surface shared by a root Drizzle database and its transaction-bound executor. */
export type DbExecutor = Omit<Db, "$client">;
