/** Where to go after signing in: only same-site paths, so the `next` parameter cannot be used as an open redirect. */
export function nextPath(search: string): string {
  const n = new URLSearchParams(search).get("next") ?? "";
  return n.startsWith("/") && !n.startsWith("//") && !n.includes("\\") ? n : "/app";
}
