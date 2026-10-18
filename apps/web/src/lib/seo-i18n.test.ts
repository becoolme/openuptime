import { describe, expect, it } from "vitest";
import { SEGMENTS, TOOLS } from "./seo-pages";
import { faqLd, localizeSeoHtml, scriptJson, zhVariant } from "./seo-i18n";

const CJK = /[一-鿿]/;
const pages = [...TOOLS, ...SEGMENTS].map((p) => ({ slug: p.slug, title: p.title, description: p.description, faq: p.faq }));

// the head of a built page, as Base.astro and SeoShell.astro emit it
const head = (p: (typeof pages)[number]) =>
  [
    `<html lang="en"><head>`,
    `<meta name="description" content="${p.description.en.replace(/"/g, "&quot;")}"><meta property="og:description" content="${p.description.en.replace(/"/g, "&quot;")}">`,
    `<meta property="og:title" content="${p.title.en} · OpenUptime">`,
    `<script type="application/ld+json" id="seo-ld">${scriptJson(faqLd(p.faq, "en"))}</script>`,
    `<script type="application/json" id="seo-i18n">${scriptJson(zhVariant(p.title, p.description, p.faq))}</script>`,
    `<title>${p.title.en} · OpenUptime</title></head><body>x</body></html>`,
  ].join("\n");

describe("Chinese metadata of the SEO pages", () => {
  it("every page has a Chinese title, description and FAQ structured data", () => {
    for (const p of pages) {
      const zh = zhVariant(p.title, p.description, p.faq);
      expect(zh.title, p.slug).toMatch(CJK);
      expect(zh.description, p.slug).toMatch(CJK);
      const ld = zh.ld as ReturnType<typeof faqLd>;
      expect(ld.inLanguage).toBe("zh-Hans");
      expect(ld.mainEntity.length).toBe(p.faq.length);
      for (const q of ld.mainEntity) {
        expect(q.name, p.slug).toMatch(CJK);
        expect(q.acceptedAnswer.text, p.slug).toMatch(CJK);
      }
    }
  });
  it("the English structured data stays English", () => {
    for (const p of pages) expect(faqLd(p.faq, "en").inLanguage).toBe("en");
  });
  it("the swap replaces title, description, og tags and JSON-LD, and drops the block", () => {
    for (const p of pages) {
      const out = localizeSeoHtml(head(p));
      const zh = zhVariant(p.title, p.description, p.faq);
      expect(out, p.slug).toContain(`<title>${zh.title.replace(/&/g, "&amp;")}</title>`);
      expect(out).not.toContain("seo-i18n");
      expect(out).not.toContain(p.title.en);
      expect(out.match(/<meta property="og:title" content="([^"]*)"/)![1]).toMatch(CJK);
      expect(out.match(/name="description" content="([^"]*)"/)![1]).toMatch(CJK);
      expect(out.match(/property="og:description" content="([^"]*)"/)![1]).toMatch(CJK);
      const ld = JSON.parse(out.match(/id="seo-ld">([\s\S]*?)<\/script>/)![1]);
      expect(ld.inLanguage).toBe("zh-Hans");
      expect(ld.mainEntity[0].name).toMatch(CJK);
    }
  });
  it("leaves other pages untouched", () => {
    const html = `<html lang="en"><head><title>Docs · OpenUptime</title><meta name="description" content="Docs"></head></html>`;
    expect(localizeSeoHtml(html)).toBe(html);
  });
});
