// Builds one landing page per language from public/index.html (English, with the dictionaries in its inline script):
// public/zh-Hans.html, public/ja.html, public/es.html. Real files per language so crawlers get the translated text,
// <html lang>, canonical and hreflang without running JavaScript. Run by `predev` / `prebuild`.
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "public");
const src = readFileSync(join(root, "index.html"), "utf8");
const ORIGIN = "https://openuptime.app";

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

const alternates =
  [{ hreflang: "en", path: "/" }, ...LOCALES, { hreflang: "x-default", path: "/" }]
    .map((l) => `<link rel="alternate" hreflang="${l.hreflang}" href="${ORIGIN}${l.path === "/" ? "/" : l.path}">`)
    .join("\n");

function build(loc) {
  const d = T[loc.code];
  // the source already carries the English canonical + alternates: drop them so each page ends with exactly its own
  let html = src.replace(/<link rel="canonical"[^>]*>\n?/g, "").replace(/<link rel="alternate" hreflang[^>]*>\n?/g, "");
  html = html.replace(/<html lang="[^"]*"/, `<html lang="${loc.code}"`);
  if (d.title) html = html.replace(/<title>[\s\S]*?<\/title>/, `<title>${esc(d.title)}</title>`);
  if (d.desc) html = html.replace(/(<meta name="description" content=")[^"]*(")/, `$1${esc(d.desc)}$2`);
  html = html.replace(/(<(\w+)\b[^>]*\bdata-i18n="([^"]+)"[^>]*>)([^<]*)(<\/\2>)/g, (m, open, _tag, key, _old, close) =>
    d[key] != null ? `${open}${esc(d[key])}${close}` : m,
  );
  // pages that exist in this language keep the visitor in it; the rest are shared
  if (loc.code === "zh-CN") html = html.replace(/href="\/(login|signup|app|docs|docs\/api|docs\/embed|docs\/self-host|privacy|terms)"/g, 'href="/zh-Hans/$1"');
  html = html.replace(/href="\/"/g, `href="${loc.path}"`);
  html = html.replace("</head>", `<link rel="canonical" href="${ORIGIN}${loc.path}">\n${alternates}\n</head>`);
  return html;
}

// the English page gets canonical + alternates too (it is the source file, so patch it once, idempotently)
let en = src.replace(/<link rel="canonical"[^>]*>\n?/g, "").replace(/<link rel="alternate" hreflang[^>]*>\n?/g, "");
en = en.replace("</head>", `<link rel="canonical" href="${ORIGIN}/">\n${alternates}\n</head>`);
if (en !== src) writeFileSync(join(root, "index.html"), en);

for (const loc of LOCALES) writeFileSync(join(root, `${loc.file}.html`), build(loc));
console.log("landing pages:", ["index", ...LOCALES.map((l) => l.file)].join(", "));
