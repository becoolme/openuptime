import type { Database, Repo, Scope } from "@openuptime/repo";
import type { createAuth } from "./auth";
import type { Entitlements } from "./entitlements";
import type { CheckQueue } from "./scheduler";

export type Bindings = {
  /** Cloudflare Hyperdrive binding (production). */
  HYPERDRIVE?: { connectionString: string };
  /** Direct connection string (local dev / non-Cloudflare). */
  DATABASE_URL?: string;
  BETTER_AUTH_SECRET: string;
  BETTER_AUTH_URL: string;
  /** Origin of the Astro app, allowed for CORS + cookies. */
  WEB_ORIGIN: string;
  GITHUB_CLIENT_ID?: string;
  GITHUB_CLIENT_SECRET?: string;
  /** Cloudflare Queue the cron fans checks out to. Unset locally: checks then run inline. */
  CHECK_QUEUE?: CheckQueue;
  /** Cloudflare Email Service `send_email` binding. Unset (local dev): emails are logged instead of sent. */
  EMAIL?: { send(msg: { from: string | { email: string; name: string }; to: string; subject: string; html?: string; text?: string; headers?: Record<string, string> }): Promise<{ messageId?: string }> };
  /** Sender address on a domain onboarded to Email Sending, e.g. "alerts@example.com". */
  EMAIL_FROM?: string;
  /** Node/Docker only: SMTP connection URL, e.g. smtps://user:pass@smtp.example.com. With EMAIL_FROM it enables outgoing mail. */
  SMTP_URL?: string;
  /** Alternative to SMTP_URL: host, port (default 587, or 465 with SMTP_SECURE=true), SMTP_USER/SMTP_PASS. */
  /** Shortcut for Resend: sends through smtp.resend.com:465 with this API key (also set EMAIL_FROM on a verified domain). */
  RESEND_API_KEY?: string;
  SMTP_HOST?: string;
  SMTP_PORT?: string;
  SMTP_SECURE?: string;
  SMTP_USER?: string;
  SMTP_PASS?: string;
  /** "true" closes registration: new accounts can only be created by someone with a pending invitation. */
  DISABLE_SIGNUP?: string;
  /** Cloudflare Turnstile: with both keys set, email sign-up shows the widget and the API verifies the token. */
  TURNSTILE_SITE_KEY?: string;
  TURNSTILE_SECRET_KEY?: string;
  /** "true" makes sign-up show "you agree to the Terms and Privacy Policy" (the bundled pages describe the hosted service, so off by default). */
  LEGAL_LINKS?: string;
  /** "true" when exactly one reverse proxy sits in front (Docker/Node): its x-forwarded-for is then trusted for rate limits. */
  TRUST_PROXY?: string;
  /** Days a team invitation stays valid. Default 7. */
  INVITE_TTL_DAYS?: string;
  /** "true" lets monitors and alert webhooks target private, loopback and link-local addresses (default: refused). */
  ALLOW_PRIVATE_TARGETS?: string;
  /** User-Agent of HTTP checks. Default: OpenUptime/0.1 (+https://github.com/becoolme/openuptime). */
  CHECK_USER_AGENT?: string;
  /** Comma-separated URLs a failed network-level check fetches to tell "the target is down" from "this machine is offline". Unset: three well-known public URLs; empty: no self-check. */
  SELFCHECK_URLS?: string;
  /** Shared secret that lets an external cron hit POST /internal/run-checks. */
  CRON_SECRET?: string;
  /**
   * Remote check regions: JSON object of region id to the probe's URL (or `{"url", "name"}`), e.g.
   * {"us-east":"https://probe.example.app/api/probe/us-east"}. Unset: monitors can only run from `auto`.
   */
  PROBE_REGIONS?: string;
  /** Secret the probes in PROBE_REGIONS verify requests with (required for those regions to be usable). */
  PROBE_SECRET?: string;
  /**
   * iOS push notifications (APNs). All four must be set: the APNs Auth Key (.p8 file contents; literal `\n` is accepted),
   * its key id, the Apple team id and the app's bundle id.
   */
  APNS_KEY?: string;
  APNS_KEY_ID?: string;
  APNS_TEAM_ID?: string;
  APNS_BUNDLE_ID?: string;
};

export type Auth = ReturnType<typeof createAuth>;

export type Variables = {
  repo: Repo;
  database: Database;
  auth: Auth;
  /** Usage allowance of workspaces: unmetered unless the hosted edition passes its own. */
  entitlements: Entitlements;
  userId: string;
  orgId: string;
  /** Active project inside the workspace (cookie `ou_project` / header `x-project-id`, else the oldest). */
  projectId: string;
  /**
   * The request asked for the "All projects" view (cookie `ou_project=all` / header `x-project-id: all`). `projectId` is
   * then only the fallback project; the monitor and incident lists read every project the caller may see, and writes
   * to project-scoped routes are refused (see rejectInAllProjects).
   */
  allProjects: boolean;
  /** Set for API keys limited to some projects: the only project ids this request may touch (null = no limit). */
  projectScope: Scope;
  /**
   * Workspaces a key or an OAuth grant may switch between with `x-workspace-id`, each with its project limit
   * (null = no limit); "all" = any workspace the user belongs to. null for a signed-in session.
   */
  workspaceGrant: null | "all" | Map<string, string[] | null>;
};

export type AppEnv = { Bindings: Bindings; Variables: Variables };

export function connectionString(env: Bindings): string {
  const cs = env.HYPERDRIVE?.connectionString ?? env.DATABASE_URL;
  if (!cs) throw new Error("No database configured: bind HYPERDRIVE or set DATABASE_URL");
  return cs;
}
