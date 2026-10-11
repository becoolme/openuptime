import { zh } from "./zh";

export type Locale = "en" | "zh-CN";
export const LOCALES: Record<Locale, string> = { en: "English", "zh-CN": "简体中文" };
export const COOKIE = "ou_lang";

export function pickLocale(cookie: string | null | undefined, acceptLanguage?: string | null, pathname?: string): Locale {
  // the URL wins: /zh-Hans/... is Chinese, any other path (even with a cookie saying otherwise) is whatever the cookie says
  if (pathname && /^\/zh-Hans(\/|$)/.test(pathname)) return "zh-CN";
  // public status pages are indexed: the URL alone decides, so crawlers (and everyone without /zh-Hans) get English
  if (pathname && /^\/status(\/|$)/.test(pathname)) return "en";
  const m = cookie?.match(new RegExp(`${COOKIE}=([^;]+)`))?.[1];
  if (m === "en" || m === "zh-CN") return m;
  if (m === "ja" || m === "es") return "en"; // landing page only
  return acceptLanguage?.toLowerCase().startsWith("zh") ? "zh-CN" : "en";
}

/** English text is the key; locales without an entry fall back to English. */
export function translate(locale: Locale, s: string): string {
  return locale === "zh-CN" ? (zh[s] ?? s) : s;
}

/** For React islands (rendered client-side only): reads the locale the server put on <html>. */
export function t(s: string): string {
  const lang = typeof document === "undefined" ? "en" : document.documentElement.lang;
  return translate(lang === "zh-CN" ? "zh-CN" : "en", s);
}
