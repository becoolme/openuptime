import { verifyAccessToken } from "@openuptime/mcp-rest/oauth";
import type { Bindings } from "./env";
import { mcpResource } from "./auth";

/** What an agent was given: every workspace of the user, or a list of workspaces with an optional project limit each. */
export type OAuthGrant = { userId: string; all: boolean; workspaces: { id: string; projects?: string[] }[]; scopes: string[]; clientId?: string };

type JwksSource = { api: { getJwks: () => Promise<unknown> } };

/** Verifies a bearer token issued by our own authorization server for the MCP resource; null if it is not one. */
export async function verifyOAuthToken(auth: JwksSource, env: Bindings, token: string): Promise<OAuthGrant | null> {
  const payload = await verifyAccessToken(token, {
    jwks: () => auth.api.getJwks(),
    issuer: `${new URL(env.BETTER_AUTH_URL).origin}/api/auth`,
    audience: mcpResource(env),
  });
  if (!payload || typeof payload.sub !== "string") return null;
  const scope = typeof payload.scope === "string" ? payload.scope : "";
  const strings = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : undefined);
  let workspaces: OAuthGrant["workspaces"] = [];
  if (Array.isArray(payload.workspaces)) {
    for (const w of payload.workspaces as { id?: unknown; projects?: unknown }[]) {
      if (typeof w?.id === "string") workspaces.push({ id: w.id, projects: strings(w.projects) });
    }
  } else if (typeof payload.org === "string") {
    workspaces = [{ id: payload.org, projects: strings(payload.projects) }];
  }
  return {
    userId: payload.sub,
    all: payload.all_workspaces === true,
    workspaces,
    scopes: scope.split(/\s+/).filter(Boolean),
    clientId: typeof payload.azp === "string" ? payload.azp : undefined,
  };
}
