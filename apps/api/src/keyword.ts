import { RE2JS } from "re2js";

/**
 * How a monitor's keyword is looked for in a response body or WebSocket message: as plain text ("contains", "absent")
 * or as a regular expression ("matches", "not_matches").
 *
 * Patterns run on RE2, which takes time proportional to the text whatever the pattern, so a pattern cannot stall a check
 * by backtracking. RE2 has no backreferences or lookarounds; such a pattern is refused when the monitor is saved.
 */

export const KEYWORD_MODES = ["contains", "absent", "matches", "not_matches"] as const;
export type KeywordMode = (typeof KEYWORD_MODES)[number];
/** Probes that understand the pattern modes advertise this; an older probe would look for the pattern as plain text. */
export const KEYWORD_REGEX_CAPABILITY = "keyword-regex-v1";
export const MAX_KEYWORD_LENGTH = 500;

export const isPatternMode = (mode: string | null | undefined) => mode === "matches" || mode === "not_matches";

/** Why a keyword cannot be saved with this mode, or null. */
export function keywordProblem(keyword: string, mode: string): string | null {
  if (keyword.length > MAX_KEYWORD_LENGTH) return `Use at most ${MAX_KEYWORD_LENGTH} characters`;
  if (!isPatternMode(mode)) return null;
  try {
    RE2JS.compile(keyword);
    return null;
  } catch (e) {
    // RE2's own wording, e.g. "invalid or unsupported Perl syntax: `(?=`"
    const detail = (e as Error).message.replace(/^error parsing regexp:\s*/, "");
    return `Not a usable regular expression (${detail}). Backreferences and lookarounds are not supported`;
  }
}

/** Whether the keyword is in the text: as a substring, or for the pattern modes as a match anywhere in it. */
export function keywordFound(keyword: string, mode: string | null | undefined, text: string): boolean {
  if (!isPatternMode(mode)) return text.includes(keyword);
  return RE2JS.compile(keyword).test(text);
}

/** Whether the text passes the monitor's keyword rule, and the error to show when it does not. */
export function keywordOutcome(keyword: string, mode: string | null | undefined, text: string, where: string): { ok: true } | { ok: false; error: string } {
  let found: boolean;
  try {
    found = keywordFound(keyword, mode, text);
  } catch {
    // only reachable for a pattern stored before validation, or edited around it
    return { ok: false, error: `Keyword pattern "${keyword}" is not a usable regular expression` };
  }
  const wantFound = mode !== "absent" && mode !== "not_matches";
  if (found === wantFound) return { ok: true };
  if (isPatternMode(mode)) return { ok: false, error: wantFound ? `No match for /${keyword}/ in ${where}` : `Unexpected match for /${keyword}/ in ${where}` };
  return { ok: false, error: wantFound ? `Keyword "${keyword}" not found in ${where}` : `Unexpected keyword "${keyword}" found in ${where}` };
}
