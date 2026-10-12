/** The logo shown for a status page that hides the OpenUptime brand: the favicon of the website the page links to. */
export function siteLogo(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    const u = new URL(url);
    if (u.protocol !== "https:" && u.protocol !== "http:") return null;
    if (!u.hostname) return null;
    return `https://favicon.im/${u.hostname}`;
  } catch {
    return null;
  }
}
