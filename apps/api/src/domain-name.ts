/** An explicit registered domain, never a URL, IP literal, wildcard, or inferred parent domain. */
export function domainName(value: string): string {
  const input = value.trim().replace(/\.$/, "");
  if (!input || /[\s/:@?#\\]/.test(input)) throw new Error("Use a registered domain name without a URL or path");
  let name: string;
  try { name = new URL(`https://${input}`).hostname.toLowerCase(); } catch { throw new Error("Invalid registered domain name"); }
  if (name.length > 253 || !name.includes(".") || /^[\d.]+$/.test(name) || !name.split(".").every((l) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(l))) throw new Error("Invalid registered domain name");
  return name;
}
