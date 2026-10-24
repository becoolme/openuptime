import type { Database } from "@openuptime/repo";
import type { Tool } from "@openuptime/mcp-rest";
import type { Hono } from "hono";
import { unmetered, type Entitlements } from "./entitlements";
import type { AppEnv, Bindings } from "./env";

/**
 * The seam between this open-source core and a hosted edition. Everything a hosted build adds (plans, billing, usage
 * tables) plugs in through these three hooks, so it lives in files of its own and never edits the core.
 */
export interface Edition {
  /** Reported by `GET /api/config` so clients can label the deployment. Absent means "community". */
  id?: string;
  /**
   * Allowances for a request or a scheduler run. Built from the database in hand because Workers open one per
   * request; an implementation keeps its state in tables, not in memory.
   */
  entitlements(ctx: { database: Database; env: Bindings }): Entitlements;
  /**
   * Extra routes. `app` is the root (public ones such as a payment webhook); `authed` sits under `/api` behind the
   * normal session / API key check.
   */
  mount?(routes: { app: Hono<AppEnv>; authed: Hono<AppEnv> }): void;
  /** Extra MCP tools, listed after the core ones. Each is a thin call into a REST route the edition mounts. */
  mcpTools?: Tool[];
  /** Schema of the edition's own tables, applied by `/internal/migrate` after ours. Returns the tags applied. */
  migrate?(database: Database): Promise<string[]>;
}

/** The open-source edition: nothing is counted and nothing is refused. */
export const community: Edition = {
  entitlements: () => unmetered,
};
