import type { L } from "./changelog";
import type { Faq } from "./seo-pages";

/**
 * Metadata of the comparison and use-case pages in both languages. The pages are built once, in English; SeoShell embeds
 * the Chinese variant in a JSON block, and the /zh-Hans route swaps it in (see localizeSeoHtml).
 */
export const SITE_SUFFIX = " · OpenUptime";

export function faqLd(faq: Faq[], lang: keyof L) {
  return {
    "@context": "https://schema.org",
    "@type": "FAQPage",
    inLanguage: lang === "zh" ? "zh-Hans" : "en",
    mainEntity: faq.map((f) => ({ "@type": "Question", name: f.q[lang], acceptedAnswer: { "@type": "Answer", text: f.a[lang] } })),
  };
}

/** JSON for a script element: "<" never appears raw inside it. */
export const scriptJson = (value: unknown) => JSON.stringify(value).replace(/</g, "\\u003c");

export interface SeoI18n {
  title: string;
  description: string;
  ld?: unknown;
}

export const zhVariant = (title: L, description: L, faq: Faq[]): SeoI18n => ({ title: title.zh + SITE_SUFFIX, description: description.zh, ld: faqLd(faq, "zh") });

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const BLOCK = /<script[^>]*\bid="seo-i18n"[^>]*>([\s\S]*?)<\/script>/;
const LD = /(<script[^>]*\bid="seo-ld"[^>]*>)[\s\S]*?(<\/script>)/;

/**
 * Turns a built SEO page into its Chinese-metadata version: <title>, description, og:title, og:description and the
 * FAQ structured data. Pages without the seo-i18n block are returned unchanged.
 */
export function localizeSeoHtml(html: string): string {
  const m = html.match(BLOCK);
  if (!m) return html;
  let zh: SeoI18n;
  try {
    zh = JSON.parse(m[1]) as SeoI18n;
  } catch {
    return html.replace(BLOCK, "");
  }
  return html
    .replace(BLOCK, "")
    .replace(/<title>[\s\S]*?<\/title>/, () => `<title>${esc(zh.title)}</title>`)
    .replace(/(<meta\b[^>]*\b(?:name="description"|property="og:description")[^>]*\bcontent=")[^"]*(")/g, (_, a, b) => a + esc(zh.description) + b)
    .replace(/(<meta\b[^>]*\bproperty="og:title"[^>]*\bcontent=")[^"]*(")/g, (_, a, b) => a + esc(zh.title) + b)
    .replace(LD, (m, a, b) => (zh.ld === undefined ? m : a + scriptJson(zh.ld) + b));
}
