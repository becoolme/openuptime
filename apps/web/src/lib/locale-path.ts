/** Locale URL prefixes: English is the unprefixed default; the others live under /zh-Hans, /ja, /es. */
export const PREFIXES = { "zh-CN": "zh-Hans", ja: "ja", es: "es" } as const;
export type PrefixedLocale = keyof typeof PREFIXES;
const BY_PREFIX: Record<string, PrefixedLocale> = { "zh-Hans": "zh-CN", ja: "ja", es: "es" };

/** Splits `/zh-Hans/app/team` into the locale and the path the pages know (`/app/team`). */
export function splitLocale(pathname: string): { locale: PrefixedLocale | null; rest: string } {
  const m = pathname.match(/^\/(zh-Hans|ja|es)(\/.*)?$/);
  if (!m) return { locale: null, rest: pathname };
  return { locale: BY_PREFIX[m[1]], rest: m[2] || "/" };
}

export const stripLocale = (pathname: string) => splitLocale(pathname).rest;

/** `path` (without prefix, may carry ?query/#hash) for `locale`; English and unknown locales stay unprefixed. */
export function withLocale(path: string, locale: string): string {
  const prefix = PREFIXES[locale as PrefixedLocale];
  const m = path.match(/^([^?#]*)(.*)$/)!;
  const rest = stripLocale(m[1]);
  if (!prefix) return rest + m[2];
  return `/${prefix}${rest === "/" ? "" : rest}${m[2]}`;
}

/** Locale of the page being viewed, from its URL (null = default English). */
export const pageLocale = (): PrefixedLocale | null =>
  typeof location === "undefined" ? null : splitLocale(location.pathname).locale;

/** An internal path in the language of the page being viewed. */
export const lp = (path: string) => withLocale(path, pageLocale() ?? "en");

/** Go to `path` in the current language (full page load). */
export const go = (path: string) => { location.href = lp(path); };

/** Remember `locale` and reload the same page under that language's URL. */
export function switchLocale(locale: string) {
  document.cookie = `ou_lang=${locale};path=/;max-age=31536000;samesite=lax`;
  location.assign(withLocale(location.pathname, locale) + location.search + location.hash);
}
