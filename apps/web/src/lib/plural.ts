import { t, translate, type Locale } from "./i18n";

/** "1 monitor" / "3 monitors": the English singular or plural key is translated; Chinese has no plural, so both map to one phrase. */
export function countLabel(locale: Locale, n: number, one: string, other: string): string {
  return `${n} ${translate(locale, n === 1 ? one : other)}`;
}

/** `countLabel` in the language of the page. */
export function plural(n: number, one: string, other: string): string {
  return `${n} ${t(n === 1 ? one : other)}`;
}
