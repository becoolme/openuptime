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
  EMAIL?: { send(msg: { from: string | { email: string; name: string }; to: string; subject: string; html?: string; text?: string }): Promise<{ messageId?: string }> };
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
  /** Days a team invitation stays valid. Default 7. */
  INVITE_TTL_DAYS?: string;
  /** "true" lets monitors and alert webhooks target private, loopback and link-local addresses (default: refused). */
  ALLOW_PRIVATE_TARGETS?: string;
  /** User-Agent of HTTP checks. Default: OpenUptime/0.1 (+https://github.com/becoolme/openuptime). */
  CHECK_USER_AGENT?: string;
  /** Shared secret that lets an external cron hit POST /internal/run-checks. */
  CRON_SECRET?: string;
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
