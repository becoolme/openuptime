import type { Repo } from "@openuptime/repo";
import type { Context } from "hono";
import type { AppEnv, Bindings } from "./env";

const onWorkers = typeof navigator !== "undefined" && navigator.userAgent === "Cloudflare-Workers";
const proxied = (env: Pick<Bindings, "TRUST_PROXY"> | undefined) => ["true", "1"].includes(String(env?.TRUST_PROXY ?? "").trim().toLowerCase());

/**
 * The caller's address, or null when it cannot be told. On Cloudflare the edge sets `cf-connecting-ip`; anywhere else
 * a client can send any header it likes, so forwarding headers count only with TRUST_PROXY=true (exactly one reverse
 * proxy in front, which appends the real address to `x-forwarded-for`).
 */
export function clientIp(c: Context, env?: Pick<Bindings, "TRUST_PROXY">): string | null {
  if (onWorkers) return c.req.header("cf-connecting-ip") ?? null;
  if (!proxied(env ?? (c.env as Bindings | undefined))) return null;
  const forwarded = c.req.header("x-forwarded-for")?.split(",").map((s) => s.trim()).filter(Boolean);
  return c.req.header("cf-connecting-ip") ?? forwarded?.[forwarded.length - 1] ?? null;
}

/** Counts one attempt under `key`; false once more than `limit` happened within `windowSec`. */
export const allow = (repo: Repo, key: string, limit: number, windowSec: number) => repo.withinLimit(key, limit, windowSec);

/** Constant-time string comparison (shared secrets). */
export function safeEqual(a: string | undefined | null, b: string | undefined | null): boolean {
  if (typeof a !== "string" || typeof b !== "string") return false;
  const x = new TextEncoder().encode(a);
  const y = new TextEncoder().encode(b);
  let diff = x.length ^ y.length;
  for (let i = 0; i < Math.max(x.length, y.length); i++) diff |= (x[i] ?? 0) ^ (y[i] ?? 0);
  return diff === 0;
}

export type { AppEnv };
