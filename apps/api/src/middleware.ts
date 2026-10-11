import type { Repo, Scope } from "@openuptime/repo";
import { createMiddleware } from "hono/factory";
import { HTTPException } from "hono/http-exception";
import type { AppEnv } from "./env";
import { verifyOAuthToken } from "./oauth";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Resolves the session and the active organization; 401 if there is none. */
export const requireOrg = createMiddleware<AppEnv>(async (c, next) => {
  const auth = c.get("auth");
  const session = await auth.api.getSession({ headers: c.req.raw.headers });
  let userId = session?.user.id;
  let orgId = (session?.session as { activeOrganizationId?: string | null } | undefined)?.activeOrganizationId ?? undefined;

  let fromKey = false;
  let scope: Scope = null;
  let granted: AppEnv["Variables"]["workspaceGrant"] = null;
  if (!session) {
    // API-key access (Authorization: Bearer ou_… or x-api-key)
    const raw = c.req.header("x-api-key") ?? c.req.header("authorization")?.replace(/^Bearer\s+/i, "");
    // an agent authorized through OAuth (MCP): a signed JWT for our MCP resource
    const grant = raw ? await verifyOAuthToken(auth, c.env, raw) : null;
    // the signature is valid, but the user may have withdrawn the grant since: no consent on file, no access
    if (grant && !(grant.clientId && (await c.get("repo").hasOAuthConsent(grant.userId, grant.clientId)))) {
      throw new HTTPException(401, { message: "This authorization was revoked" });
    }
    if (grant) {
      const write = !["GET", "HEAD", "OPTIONS"].includes(c.req.method);
      if (!grant.scopes.includes(write ? "mcp:write" : "mcp:read") && !(write ? false : grant.scopes.includes("mcp:write"))) {
        throw new HTTPException(403, { message: `This token lacks the ${write ? "mcp:write" : "mcp:read"} scope` });
      }
      userId = grant.userId;
      fromKey = true;
      // an agent may be given several workspaces (or all of them): it says which one it works in per request
      const asked = c.req.header("x-workspace-id");
      if (grant.all) {
        granted = "all";
        orgId = asked;
      } else {
        granted = new Map(grant.workspaces.map((w) => [w.id, w.projects?.length ? w.projects.filter((p) => UUID.test(p)) : null]));
        orgId = asked ?? grant.workspaces[0]?.id;
        if (!orgId || !granted.has(orgId)) throw new HTTPException(403, { message: "This authorization does not include that workspace" });
        scope = granted.get(orgId) ?? null;
        if (scope && !scope.length) throw new HTTPException(403, { message: "This authorization has no valid projects" });
      }
    } else if (raw) {
      const res = await auth.api.verifyApiKey({ body: { key: raw } }).catch(() => null);
      if (res?.valid && res.key) {
        userId = res.key.referenceId;
        fromKey = true;
        const meta = res.key.metadata as { organizationId?: string; projectIds?: unknown } | null;
        orgId = meta?.organizationId;
        // a key limited to some projects: only those, whatever the caller asks for
        if (Array.isArray(meta?.projectIds) && meta.projectIds.length) scope = meta.projectIds.filter((p): p is string => typeof p === "string" && UUID.test(p));
        if (scope && !scope.length) throw new HTTPException(403, { message: "API key has no valid projects" });
      }
    }
  }
  if (!userId) throw new HTTPException(401, { message: "Unauthorized" });

  const repo = c.get("repo");
  const wanted = c.req.header("x-project-id") ?? cookieValue(c.req.header("cookie"), "ou_project") ?? scope?.[0];
  // the org id comes from user-supplied key metadata: only trust it for orgs the user belongs to
  if (orgId && fromKey && !(await repo.isMember(userId, orgId))) throw new HTTPException(403, { message: "Not a member of this workspace" });
  if (!orgId) {
    orgId = (await repo.anyWorkspaceOf(userId)) ?? undefined;
    if (!orgId) throw new HTTPException(403, { message: "No workspace" });
  }
  const projectId = await cachedProject(repo, orgId, wanted);
  if (scope && !scope.includes(projectId)) throw new HTTPException(403, { message: "API key has no access to this project" });
  c.set("projectId", projectId);
  c.set("projectScope", scope);
  // a key sees only its own workspace
  c.set("workspaceGrant", granted ?? (fromKey ? new Map([[orgId, scope]]) : null));
  c.set("userId", userId);
  c.set("orgId", orgId);
  await next();
});

/** Destructive actions are for workspace owners and admins; a plain member (by session, API key or agent) gets 403. */
export const requireManager = createMiddleware<AppEnv>(async (c, next) => {
  const role = await c.get("repo").memberRole(c.get("userId"), c.get("orgId"));
  if (role !== "owner" && role !== "admin") throw new HTTPException(403, { message: "Only workspace owners and admins can delete this" });
  await next();
});

function cookieValue(header: string | undefined, name: string) {
  const m = header?.split(/;\s*/).find((p) => p.startsWith(`${name}=`));
  return m ? decodeURIComponent(m.slice(name.length + 1)) : undefined;
}

// each lookup is a database round trip (~350ms to the origin): remember answers briefly per isolate
const projectCache = new Map<string, { id: string; until: number }>();
export const forgetProjects = (orgId: string) => {
  for (const k of projectCache.keys()) if (k.startsWith(orgId + "|")) projectCache.delete(k);
};
async function cachedProject(repo: Repo, orgId: string, wanted?: string) {
  const key = `${orgId}|${wanted ?? ""}`;
  const hit = projectCache.get(key);
  if (hit && hit.until > Date.now()) return hit.id;
  const id = await repo.resolveProject(orgId, wanted);
  projectCache.set(key, { id, until: Date.now() + 30_000 });
  return id;
}
