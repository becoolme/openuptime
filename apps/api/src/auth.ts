import { apiKey } from "@better-auth/api-key";
import { oauthProvider } from "@better-auth/oauth-provider";
import type { Database } from "@openuptime/repo";
import { betterAuth } from "better-auth";
import { APIError, createAuthMiddleware } from "better-auth/api";
import { jwt, organization, twoFactor } from "better-auth/plugins";
import { actionEmail, sendEmail } from "./email";
import { userLang, tr } from "./mail-i18n";
import type { Bindings } from "./env";

export function slugify(s: string) {
  return (s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "workspace") + "-" + Math.random().toString(36).slice(2, 6);
}

/** Invitation lifetime in days: INVITE_TTL_DAYS when it is a positive number, else 7. */
export function inviteTtlDays(env: Pick<Bindings, "INVITE_TTL_DAYS">) {
  const n = Number(env.INVITE_TTL_DAYS);
  return Number.isFinite(n) && n > 0 ? n : 7;
}

/** Registration is closed (DISABLE_SIGNUP=true): only people with a pending invitation can still create an account. */
export const signupDisabled = (env: Pick<Bindings, "DISABLE_SIGNUP">) => ["true", "1"].includes(String(env.DISABLE_SIGNUP ?? "").trim().toLowerCase());

// scopes a token for the MCP resource may carry; offline_access must be here or refresh grants never keep it
const MCP_RESOURCE_SCOPES = ["mcp:read", "mcp:write", "offline_access"];

/** OAuth scopes an agent can be granted: read-only, or read and change. */
export const OAUTH_SCOPES = ["openid", "offline_access", "mcp:read", "mcp:write"] as const;

/** The MCP endpoint, which is the OAuth "resource" access tokens are issued for (RFC 8707). */
export const mcpResource = (env: Pick<Bindings, "BETTER_AUTH_URL">) => `${new URL(env.BETTER_AUTH_URL).origin}/api/mcp`;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * What the picker page leaves in a short-lived cookie, and what a consent stores as its reference:
 * `*` = every workspace the user is in; otherwise `;`-separated entries, each `<workspace id>` (all of its projects)
 * or `<workspace id>|<project id>,<project id>` (only those). The cookie may also say `<workspace id>|*`.
 */
export const GRANT_COOKIE = "ou_grant";
/**
 * The cookie reads `<code_challenge>~<grant>`: it only counts for the authorization request (one PKCE challenge) the
 * picker was shown for, so an answer left over from an earlier attempt can never skip the picker of a later one.
 */
const grantCookie = (header: string | null | undefined, challenge: string) => {
  const m = header?.split(/;\s*/).find((p) => p.startsWith(`${GRANT_COOKIE}=`));
  const v = m ? decodeURIComponent(m.slice(GRANT_COOKIE.length + 1)) : "";
  const i = v.indexOf("~");
  return i >= 0 && v.slice(0, i) === challenge ? v.slice(i + 1) || undefined : undefined;
};
type GrantEntry = { org: string; ids: string[] | null };
export function parseGrant(raw: string): "all" | GrantEntry[] {
  if (raw.trim() === "*") return "all";
  return raw
    .split(";")
    .map((e) => e.split("|"))
    .filter(([org]) => !!org)
    .map(([org, sel]) => ({ org, ids: !sel || sel === "*" ? null : sel.split(",") }));
}

export function createAuth(database: Database, env: Bindings) {
  const repo = database.repo;
  // this auth object lives for one request, so the cookie of that request can be parked here for the OAuth callbacks
  let picked: string | undefined;
  return betterAuth({
    baseURL: env.BETTER_AUTH_URL,
    secret: env.BETTER_AUTH_SECRET,
    trustedOrigins: [env.WEB_ORIGIN],
    // signed session cookie cache: most requests skip the session/user DB lookups entirely
    session: { cookieCache: { enabled: true, maxAge: 5 * 60 } },
    database: database.authDatabase as never,
    // verification is requested at sign-up but never blocks sign-in, so accounts created before it existed keep working
    emailVerification: {
      sendOnSignUp: true,
      autoSignInAfterVerification: true,
      sendVerificationEmail: async ({ user, url }) => {
        const lang = await userLang(repo, user.email);
        const mail = actionEmail({
          title: tr(lang, "Verify your email address"),
          body: tr(lang, "Confirm this address so we can reach you about your OpenUptime account and recover it if you lose access."),
          footer: tr(lang, "Didn't create an OpenUptime account? Ignore this email."),
          cta: tr(lang, "Verify email"),
          url,
          lang,
        });
        await sendEmail({ to: user.email, subject: tr(lang, "Verify your OpenUptime email"), fromName: "OpenUptime", ...mail });
      },
    },
    user: {
      deleteUser: {
        enabled: true,
        // a workspace nobody else belongs to goes with its owner; one with other members must be handed over first
        beforeDelete: async (u) => {
          const owned = await repo.ownedWorkspaces(u.id);
          const shared = owned.find((o) => o.members > 1);
          if (shared) throw new APIError("BAD_REQUEST", { message: `Remove the other members of "${shared.name}" (or delete it) before deleting your account` });
          await repo.deleteWorkspaces(owned.map((o) => o.id));
        },
      },
    },
    emailAndPassword: {
      enabled: true,
      minPasswordLength: 8,
      sendResetPassword: async ({ user, url }) => {
        const lang = await userLang(repo, user.email);
        const mail = actionEmail({
          title: tr(lang, "Reset your password"),
          body: tr(lang, "Someone asked to reset the password for your OpenUptime account. If that wasn't you, ignore this email and nothing will change."),
          footer: tr(lang, "Security email. You can't unsubscribe from these."),
          cta: tr(lang, "Choose a new password"),
          url,
          lang,
        });
        await sendEmail({ to: user.email, subject: tr(lang, "Reset your OpenUptime password"), fromName: "OpenUptime", ...mail });
      },
    },
    socialProviders:
      env.GITHUB_CLIENT_ID && env.GITHUB_CLIENT_SECRET
        ? { github: { clientId: env.GITHUB_CLIENT_ID, clientSecret: env.GITHUB_CLIENT_SECRET } }
        : {},
    hooks: {
      // Most MCP clients register without an application_type and use a loopback or custom-scheme redirect; the
      // OIDC default ("web") would refuse those, so such clients are treated as the native apps they are.
      before: createAuthMiddleware(async (ctx) => {
        // access tokens are issued for the MCP endpoint; the resource row is created on first use because the
        // identifier is this deployment's own URL (known only at runtime, so it cannot ship in a migration)
        if (["/oauth2/authorize", "/oauth2/continue", "/oauth2/consent"].includes(ctx.path)) {
          const q = ctx.path === "/oauth2/authorize" ? (ctx.query as Record<string, unknown> | undefined)?.code_challenge : new URLSearchParams(String((ctx.body as { oauth_query?: unknown } | undefined)?.oauth_query ?? "")).get("code_challenge");
          picked = grantCookie(ctx.headers?.get("cookie"), typeof q === "string" ? q : "");
        }
        if (ctx.path === "/oauth2/authorize" || ctx.path === "/oauth2/token") {
          await repo.ensureOAuthResource(mcpResource(env), "OpenUptime MCP", MCP_RESOURCE_SCOPES);
          // clients repeat the original scope (including offline_access) on refresh, and the library rejects any scope
          // the grant does not hold. Grants issued before the resource allowed offline_access never stored it, so
          // for those it is dropped (it only means "issue a refresh token" and cannot widen access).
          const body = ctx.body as Record<string, unknown> | undefined;
          if (ctx.path === "/oauth2/token" && body?.grant_type === "refresh_token" && typeof body.scope === "string" && typeof body.refresh_token === "string") {
            const asked = body.scope.split(/\s+/).filter(Boolean);
            if (asked.includes("offline_access")) {
              const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(body.refresh_token)));
              const stored = btoa(String.fromCharCode(...digest)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
              const rows = await database.query<{ scopes: string }>("select array_to_string(scopes, ' ') as scopes from oauth_refresh_token where token = $1", [stored]);
              const held = rows[0] ? String(rows[0].scopes).split(" ").filter(Boolean) : undefined;
              const kept = asked.filter((x) => x !== "offline_access");
              if (held && (!held.includes("offline_access") || !kept.length)) {
                return { context: { ...ctx, body: { ...body, scope: (kept.length ? kept : held).join(" ") } } };
              }
            }
          }
          return;
        }
        const body = ctx.body as { application_type?: string; redirect_uris?: unknown } | undefined;
        if (ctx.path !== "/oauth2/register" || !body || body.application_type || !Array.isArray(body.redirect_uris)) return;
        const native = body.redirect_uris.every((u) => {
          try {
            const url = new URL(String(u));
            return url.protocol === "http:" ? ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) : url.protocol !== "https:";
          } catch {
            return false;
          }
        });
        if (native) return { context: { ...ctx, body: { ...body, application_type: "native" } } };
      }),
    },
    plugins: [
      organization({
        invitationExpiresIn: Math.round(inviteTtlDays(env) * 86400),
        organizationHooks: {
          // the workspace owner is the one account that cannot be taken out of it
          beforeRemoveMember: async ({ member }) => {
            if (member.role === "owner") throw new APIError("BAD_REQUEST", { message: "The workspace owner cannot be removed" });
          },
        },
        sendInvitationEmail: async ({ email, id, organization: org, inviter, invitation }) => {
          const expires = (invitation as { expiresAt?: Date | string } | undefined)?.expiresAt;
          const expiresAt = expires ? new Date(expires) : new Date(Date.now() + inviteTtlDays(env) * 864e5);
          const until = expiresAt.toISOString().slice(0, 10);
          // the invitee's own setting if they already have an account, else the inviter's
          const lang = await userLang(repo, email, await userLang(repo, inviter.user.email));
          const who = inviter.user.name || inviter.user.email;
          const mail = actionEmail({
            title: tr(lang, "Join {org} on OpenUptime", { org: org.name }),
            body: tr(lang, "{who} invited you to collaborate on {org}. You'll be able to see its monitors, incidents and status pages.", { who, org: org.name }),
            rows: [[tr(lang, "Workspace"), org.name], [tr(lang, "Invited by"), who], [tr(lang, "Valid until"), until]],
            footer: tr(lang, "Not expecting this? Ignore this email and the invitation expires on its own."),
            cta: tr(lang, "Accept invitation"),
            url: `${env.WEB_ORIGIN}/accept-invite/${id}`,
            lang,
          });
          await sendEmail({ to: email, subject: tr(lang, "Join {org} on OpenUptime", { org: org.name }), fromName: "OpenUptime", ...mail });
        },
      }),
      // the plugin's default allows 10 requests per key per day; the REST API has no per-key quota
      apiKey({ enableMetadata: true, defaultPrefix: "ou_", rateLimit: { enabled: false } }),
      twoFactor({ issuer: "OpenUptime" }),
      // only the OAuth provider signs tokens; do not mint a JWT (and touch the keys table) on every session read
      jwt({ disableSettingJwtHeader: true }),
      // lets agents (MCP clients) register themselves and ask the user for access: OAuth 2.1 with PKCE
      oauthProvider({
        loginPage: "/login",
        consentPage: "/oauth/consent",
        scopes: [...OAUTH_SCOPES],
        allowDynamicClientRegistration: true,
        allowUnauthenticatedClientRegistration: true,
        clientRegistrationDefaultScopes: ["mcp:read", "mcp:write"],
        clientRegistrationAllowedScopes: [...OAUTH_SCOPES],
        // the auth object is rebuilt per request, so no boot-time resource seeding: any client may ask for any resource
        enforcePerClientResources: false,
        // which workspace, and which of its projects, the agent acts in: what the user picked while authorizing
        postLogin: {
          page: "/oauth/workspace",
          // the picker page sets a short-lived cookie once the user chose (the library has no other "done" signal);
          // it is only ever narrowed to workspaces and projects the user belongs to (see consentReferenceId)
          shouldRedirect: async ({ user, headers }) => {
            if (picked) return false;
            // always ask, even with a single workspace and project: the user sees exactly what the agent is given
            return (await repo.workspacesOf(user.id)).length > 0;
          },
          consentReferenceId: async ({ user, session }) => {
            if (picked) {
              const want = parseGrant(picked);
              if (want === "all") return (await repo.workspacesOf(user.id)).length ? "*" : undefined;
              const out = new Map<string, string>();
              for (const { org, ids } of want) {
                if (out.has(org) || !(await repo.isMember(user.id, org))) continue;
                if (!ids) { out.set(org, org); continue; }
                const own = new Set((await repo.listProjects(org, null)).map((p) => p.id));
                const keep = [...new Set(ids)].filter((id) => UUID.test(id) && own.has(id));
                if (keep.length) out.set(org, keep.length === own.size ? org : `${org}|${keep.join(",")}`);
              }
              if (!out.size) throw new APIError("BAD_REQUEST", { message: "Pick at least one project" });
              return [...out.values()].join(";");
            }
            const active = (session as { activeOrganizationId?: string | null }).activeOrganizationId;
            if (active && (await repo.isMember(user.id, active))) return active;
            return (await repo.anyWorkspaceOf(user.id)) ?? undefined;
          },
        },
        customAccessTokenClaims: ({ referenceId }) => {
          const g = parseGrant(referenceId ?? "");
          if (g === "all") return { all_workspaces: true };
          // `org` stays for clients holding tokens from before agents could be given several workspaces
          return { org: g[0]?.org, workspaces: g.map((e) => (e.ids ? { id: e.org, projects: e.ids } : { id: e.org })) };
        },
      }),
    ],
    databaseHooks: {
      user: {
        create: {
          // covers every way an account comes to exist: the sign-up form and a first GitHub sign-in alike
          before: async (user) => {
            if (signupDisabled(env) && !(await repo.hasPendingInvitation(user.email))) {
              throw new APIError("FORBIDDEN", { message: "Sign-ups are closed on this instance. Ask a workspace owner to invite you." });
            }
          },
          // every new user gets a personal workspace they own
          after: async (user) => {
            const name = `${user.name || user.email.split("@")[0]}'s workspace`;
            await repo.createPersonalWorkspace({ id: crypto.randomUUID(), name, slug: slugify(name), ownerId: user.id });
          },
        },
      },
      session: {
        create: {
          // keep the workspace of their previous session, else the one they joined most recently (an accepted invitation wins over the personal one)
          before: async (session) => {
            const orgId = await repo.preferredWorkspace(session.userId);
            return { data: { ...session, activeOrganizationId: orgId } };
          },
        },
      },
    },
  });
}
