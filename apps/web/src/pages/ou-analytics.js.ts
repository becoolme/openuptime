import type { APIRoute } from "astro";
import { env } from "cloudflare:workers";

export const prerender = false;

const setting = (name: string): string =>
  ((typeof process !== "undefined" ? process.env[name] : undefined) ?? (env as Record<string, string | undefined>)[name] ?? "").trim();

/**
 * Plausible, switched on by configuration instead of a rebuild: every page (static or server-rendered) loads this one file.
 *   PLAUSIBLE_DOMAIN  the site to report to (data-domain; several, comma-separated, are allowed). Unset = analytics off.
 *   PLAUSIBLE_SRC     where the script is loaded from; defaults to https://plausible.io/js/script.js (self-hosted: your own URL).
 */
export const GET: APIRoute = () => {
  const domain = setting("PLAUSIBLE_DOMAIN");
  let src = setting("PLAUSIBLE_SRC") || "https://plausible.io/js/script.js";
  try {
    const u = new URL(src);
    if (u.protocol !== "https:" && u.protocol !== "http:") throw new Error("scheme");
    src = u.toString();
  } catch {
    src = "";
  }
  const on = !!domain && !!src && /^[a-z0-9.,*-]+$/i.test(domain);
  const body = on
    ? `(function(){if(document.querySelector("script[data-domain]"))return;var s=document.createElement("script");s.defer=true;s.src=${JSON.stringify(src)};s.setAttribute("data-domain",${JSON.stringify(domain)});document.head.appendChild(s);})();`
    : "/* analytics off */";
  return new Response(body, { headers: { "content-type": "text/javascript; charset=utf-8", "cache-control": "public, max-age=300" } });
};
