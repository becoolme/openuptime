/** Kept identical for REST, MCP, imports, local checks and remote probes. */
export const HTTP_METHODS = ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"] as const;
export const MAX_REQUEST_BODY_BYTES = 16 * 1024;
export const HTTP_REQUEST_CAPABILITY = "http-request-body-v1";

export function requestBodyProblem(input: { type: string; method: string; requestBody?: string | null }): string | null {
  if (input.type === "http" && !(HTTP_METHODS as readonly string[]).includes(input.method)) return "Unsupported HTTP method";
  if (input.requestBody == null || input.requestBody === "") return null;
  if (input.type !== "http") return "Request bodies are supported for HTTP monitors only";
  if (input.method === "GET" || input.method === "HEAD") return "GET and HEAD cannot send a request body";
  if (new TextEncoder().encode(input.requestBody).byteLength > MAX_REQUEST_BODY_BYTES) return "Request body exceeds 16384 UTF-8 bytes";
  return null;
}
