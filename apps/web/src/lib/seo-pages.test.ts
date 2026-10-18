import { existsSync, readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { SEGMENTS, TOOLS, type Faq } from "./seo-pages";
import type { L } from "./changelog";

const SUFFIX = " · OpenUptime".length;
const both = (x: L) => x.en.trim().length > 0 && x.zh.trim().length > 0;
const faqs = (list: Faq[]) => list.every((f) => both(f.q) && both(f.a));
const page = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");

describe("comparison pages", () => {
  it("have unique slugs and complete content in both languages", () => {
    expect(new Set(TOOLS.map((t) => t.slug)).size).toBe(TOOLS.length);
    for (const t of TOOLS) {
      for (const x of [t.title, t.description, t.lede, t.about, ...t.theyHave, ...t.bestThem, ...t.bestUs, ...t.migrate]) expect(both(x), t.slug).toBe(true);
      for (const r of t.rows) expect([r.topic, r.ou, r.them].every(both), `${t.slug}: ${r.topic.en}`).toBe(true);
      expect(faqs(t.faq) && t.faq.length >= 3, t.slug).toBe(true);
    }
  });
  it("keep titles within 60 characters and descriptions within 155", () => {
    for (const t of TOOLS) {
      expect(t.title.en.length + SUFFIX, t.slug).toBeLessThanOrEqual(60);
      expect(t.description.en.length, t.slug).toBeLessThanOrEqual(155);
    }
  });
  it("state no prices or numeric limits of other products", () => {
    for (const t of TOOLS) {
      const text = JSON.stringify([t.rows.map((r) => r.them), t.theyHave, t.bestThem, t.about]);
      expect(text, t.slug).not.toMatch(/[$€£]\s?\d|\d+\s?(monitors|per month|\/mo)/i);
    }
  });
});

describe("use-case pages", () => {
  it("have unique slugs and complete content in both languages", () => {
    expect(new Set(SEGMENTS.map((s) => s.slug)).size).toBe(SEGMENTS.length);
    for (const s of SEGMENTS) {
      for (const x of [s.title, s.description, s.name, s.lede, s.statusPage, s.alerting, ...s.limits, ...s.scenarios.flatMap((c) => [c.title, c.body])]) expect(both(x), s.slug).toBe(true);
      expect(s.scenarios.length, s.slug).toBeGreaterThanOrEqual(3);
      expect(faqs(s.faq) && s.faq.length >= 3, s.slug).toBe(true);
      expect(s.title.en.length + SUFFIX, s.slug).toBeLessThanOrEqual(60);
      expect(s.description.en.length, s.slug).toBeLessThanOrEqual(155);
    }
  });
});

describe("sitemap", () => {
  it("lists every comparison and use-case page", () => {
    const script = page("../../scripts/gen-landing.mjs");
    const paths = ["/alternatives", "/for", ...TOOLS.map((t) => `/alternatives/${t.slug}`), ...SEGMENTS.map((s) => `/for/${s.slug}`)];
    for (const p of paths) expect(script, p).toContain(`"${p}"`);
  });
  it("lists every documentation page", () => {
    const script = page("../../scripts/gen-landing.mjs");
    const dir = fileURLToPath(new URL("../pages/docs/", import.meta.url));
    for (const f of readdirSync(dir).filter((x) => x.endsWith(".astro") && x !== "index.astro")) expect(script, f).toContain(`"/${f.replace(".astro", "")}"`);
  });
  it("gives every heading on the comparison and use-case pages an id that is unique per language", () => {
    for (const f of ["alternatives/[tool]", "for/[segment]"]) expect(page(`../pages/${f}.astro`), f).not.toMatch(/<h2 id="[a-z-]+">/);
  });
  it("has a page file for each route", () => {
    for (const f of ["alternatives/index", "alternatives/[tool]", "for/index", "for/[segment]"]) expect(existsSync(fileURLToPath(new URL(`../pages/${f}.astro`, import.meta.url))), f).toBe(true);
  });
});
