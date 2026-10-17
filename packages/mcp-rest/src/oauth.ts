import { createLocalJWKSet, jwtVerify, type JWTPayload } from "jose";

export type VerifyOptions = {
  /** Loads the authorization server's JWKS (for example `() => auth.api.getJwks()`). */
  jwks: () => Promise<unknown>;
  issuer: string;
  /** The MCP resource the token was issued for (RFC 8707). */
  audience: string;
};

/** Verifies a JWT bearer token for this resource; null if it is not one or does not check out. */
export async function verifyAccessToken(token: string, options: VerifyOptions): Promise<JWTPayload | null> {
  // opaque keys and anything that is not a JWT never reach the signature check
  if (token.split(".").length !== 3) return null;
  try {
    const keys = createLocalJWKSet((await options.jwks()) as Parameters<typeof createLocalJWKSet>[0]);
    const { payload } = await jwtVerify(token, keys, { issuer: options.issuer, audience: options.audience });
    return payload;
  } catch {
    return null;
  }
}
