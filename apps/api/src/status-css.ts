/**
 * A status page's own stylesheet. It is written into a <style> element on a public page, so it must not be able to leave
 * that element, fetch anything (a request would tell a third party who reads the page) or run script in old browsers.
 * Rather than parse CSS, the text is refused when it holds anything that could do one of those: comments are dropped
 * first, escapes are refused outright so a keyword cannot be spelled another way, and then a short list of constructs
 * that load a resource or execute is looked for. Everything else (selectors, properties, variables, media queries) is
 * left alone. The page's Content-Security-Policy keeps images and fonts to known hosts as a second line.
 */

export const MAX_CUSTOM_CSS = 20_000;

const FORBIDDEN: [RegExp, string][] = [
  [/</, "The stylesheet cannot contain <"],
  [/\\/, "Escapes (\\) are not allowed in the stylesheet"],
  [/@import/i, "@import is not allowed"],
  [/@font-face/i, "@font-face is not allowed"],
  [/@namespace/i, "@namespace is not allowed"],
  [/\burl\s*\(/i, "url() is not allowed: the page cannot load images or fonts from elsewhere"],
  [/\bsrc\s*\(/i, "src() is not allowed"],
  [/image-set\s*\(/i, "image-set() is not allowed"],
  [/\bexpression\s*\(/i, "expression() is not allowed"],
  [/javascript\s*:/i, "javascript: is not allowed"],
  [/-moz-binding|\bbehaviou?r\s*:/i, "Bindings and behaviors are not allowed"],
];

/** Drops comments, so `ur/* *\/l(` cannot hide a function name. An unclosed comment runs to the end, as in CSS. */
export const stripCssComments = (css: string) => css.replace(/\/\*[\s\S]*?(\*\/|$)/g, "");

/** Why this stylesheet is refused, or null when it may be used. */
export function customCssProblem(css: string): string | null {
  if (css.length > MAX_CUSTOM_CSS) return `The stylesheet is longer than ${MAX_CUSTOM_CSS} characters`;
  const text = stripCssComments(css);
  // dropping one comment can join two halves into a new "/*" (`//**/*`): the text that is stored and served must be the
  // text that was checked, so a comment marker left after stripping is refused rather than stripped again
  if (text.includes("/*")) return "The stylesheet has a comment that could not be removed";
  for (const [re, message] of FORBIDDEN) if (re.test(text)) return message;
  let depth = 0;
  for (const ch of text) {
    if (ch === "{") depth++;
    else if (ch === "}" && --depth < 0) return "The stylesheet has a } without a matching {";
  }
  return depth ? "The stylesheet has a { without a matching }" : null;
}
