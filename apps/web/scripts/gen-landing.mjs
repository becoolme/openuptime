// Builds one landing page per language from public/index.html (English, with the dictionaries in its inline script):
// public/zh-Hans.html, public/ja.html, public/es.html. Real files per language so crawlers get the translated text,
// <html lang>, canonical and hreflang without running JavaScript. Run by `predev` / `prebuild`.
import { readFileSync, writeFileSync, rmSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "public");
const src = readFileSync(join(root, "index.html"), "utf8");
// The public origin of the site, set when building a deployment that has one (the hosted build sets
// SITE_ORIGIN=https://openuptime.app). Without it the pages carry no canonical / hreflang / og:image / sitemap,
// so a self-hosted copy never claims to be a duplicate of someone else's domain.
const ORIGIN = (process.env.SITE_ORIGIN ?? "").replace(/\/+$/, "");

const start = src.indexOf("var T={");
const end = src.indexOf("\n}};", start);
if (start < 0 || end < 0) throw new Error("dictionary not found in public/index.html");
const T = new Function(`${src.slice(start, end + 4)}; return T;`)();

const LOCALES = [
  { code: "zh-CN", file: "zh-Hans", path: "/zh-Hans", hreflang: "zh-Hans" },
  { code: "ja", file: "ja", path: "/ja", hreflang: "ja" },
  { code: "es", file: "es", path: "/es", hreflang: "es" },
];
const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/"/g, "&quot;");

const alternates = ORIGIN
  ? [{ hreflang: "en", path: "/" }, ...LOCALES, { hreflang: "x-default", path: "/" }]
      .map((l) => `<link rel="alternate" hreflang="${l.hreflang}" href="${ORIGIN}${l.path === "/" ? "/" : l.path}">`)
      .join("\n")
  : "";
// every page under src/pages/docs is rewritten to its /zh-Hans twin, so a new docs page needs no edit here
const DOC_PAGES = readdirSync(fileURLToPath(new URL("../src/pages/docs/", import.meta.url))).filter((f) => f.endsWith(".astro") && f !== "index.astro").map((f) => `docs/${f.slice(0, -6)}`);
const ZH_LINKS = new RegExp(`href="/(login|signup|app|docs|${DOC_PAGES.join("|")}|alternatives|for|changelog|privacy|terms)"`, "g");

const STRIP = /<link rel="canonical"[^>]*>\n?|<link rel="alternate" hreflang[^>]*>\n?|<meta (?:property="og:|name="twitter:)[^>]*>\n?/g;
const attr = (html, re) => (html.match(re)?.[1] ?? "").replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&amp;/g, "&");

/** canonical + hreflang + Open Graph / Twitter tags for one language of the landing page */
function headTags(html, loc) {
  const title = attr(html, /<title>([\s\S]*?)<\/title>/);
  const desc = attr(html, /<meta name="description" content="([^"]*)"/);
  const url = ORIGIN ? `${ORIGIN}${loc.path}` : "";
  const tags = [
    ORIGIN && `<link rel="canonical" href="${url}">`,
    alternates,
    `<meta property="og:type" content="website">`,
    `<meta property="og:site_name" content="OpenUptime">`,
    `<meta property="og:title" content="${esc(title)}">`,
    `<meta property="og:description" content="${esc(desc)}">`,
    ORIGIN && `<meta property="og:url" content="${url}">`,
    ORIGIN && `<meta property="og:image" content="${ORIGIN}/og.png">`,
    `<meta name="twitter:card" content="${ORIGIN ? "summary_large_image" : "summary"}">`,
    `<meta name="twitter:title" content="${esc(title)}">`,
    `<meta name="twitter:description" content="${esc(desc)}">`,
    ORIGIN && `<meta name="twitter:image" content="${ORIGIN}/og.png">`,
  ];
  return tags.filter(Boolean).join("\n");
}

function build(loc) {
  const d = T[loc.code];
  // the source already carries the English canonical + alternates: drop them so each page ends with exactly its own
  let html = src.replace(STRIP, "");
  html = html.replace(/<html lang="[^"]*"/, `<html lang="${loc.code}"`);
  if (d.title) html = html.replace(/<title>[\s\S]*?<\/title>/, `<title>${esc(d.title)}</title>`);
  if (d.desc) html = html.replace(/(<meta name="description" content=")[^"]*(")/, `$1${esc(d.desc)}$2`);
  html = html.replace(/(<(\w+)\b[^>]*\bdata-i18n="([^"]+)"[^>]*>)([^<]*)(<\/\2>)/g, (m, open, _tag, key, _old, close) =>
    d[key] != null ? `${open}${esc(d[key])}${close}` : m,
  );
  // pages that exist in this language keep the visitor in it; the rest are shared
  if (loc.code === "zh-CN") html = html.replace(ZH_LINKS, 'href="/zh-Hans/$1"');
  // home links stay in this language; the language menu (data-l) keeps pointing at each language
  html = html.replace(/href="\/"(?![^>]*data-l=)/g, `href="${loc.path}"`);
  html = html.replace("</head>", `${headTags(html, loc)}\n</head>`);
  return html;
}

// the English page gets canonical + alternates too (it is the source file, so patch it once, idempotently)
let en = src.replace(STRIP, "");
en = en.replace("</head>", `${headTags(en, { path: "/" })}\n</head>`);
if (en !== src) writeFileSync(join(root, "index.html"), en);

for (const loc of LOCALES) writeFileSync(join(root, `${loc.file}.html`), build(loc));
// sitemap.xml and the Sitemap line of robots.txt need absolute URLs, so they exist only when the origin is known
// comparison and use-case pages (src/lib/seo-pages.ts); a test keeps this list and that file in step
const SEO_PAGES = ["/alternatives", "/alternatives/uptimerobot", "/alternatives/better-stack", "/alternatives/pingdom", "/alternatives/statuscake", "/alternatives/uptime-kuma", "/for", "/for/saas", "/for/agencies", "/for/ecommerce", "/for/devops-teams"];
const PAGES = ["/", ...LOCALES.map((l) => l.path), ...["", "/api", "/embed", "/mcp", "/self-host", "/regions", "/backup", "/websocket", "/mcp-monitors"].flatMap((p) => [`/docs${p}`, `/zh-Hans/docs${p}`]), "/changelog", "/zh-Hans/changelog", ...SEO_PAGES.flatMap((p) => [p, `/zh-Hans${p}`]), "/privacy", "/terms", "/zh-Hans/privacy", "/zh-Hans/terms"];
const robots = ["User-agent: *", "Disallow: /app", "Disallow: /zh-Hans/app", "Disallow: /api/", "Allow: /", ""];
if (ORIGIN) {
  writeFileSync(
    join(root, "sitemap.xml"),
    `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${PAGES.map((p) => `  <url><loc>${ORIGIN}${p}</loc></url>`).join("\n")}\n</urlset>\n`,
  );
  robots.push(`Sitemap: ${ORIGIN}/sitemap.xml`, "");
} else rmSync(join(root, "sitemap.xml"), { force: true });
writeFileSync(join(root, "robots.txt"), robots.join("\n"));

console.log("landing pages:", ["index", ...LOCALES.map((l) => l.file)].join(", "));
