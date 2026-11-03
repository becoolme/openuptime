import { z } from "zod";
import type { JsonAssertion } from "@openuptime/repo";
/**
 * Assertions on a JSON response body: a path into the document, a comparison and a value. Paths are read by a small
 * parser of our own (`$.data.items[0].status`, `$["odd key"]`), never handed to a regular expression or evaluated,
 * so a monitor's settings cannot make a check slow or run code.
 */

export const JSON_ASSERT_CAPABILITY = "json-assert-v1";
export const JSON_ASSERT_OPS = ["equals", "not_equals", "contains", "exists", "not_exists", "greater_than", "less_than"] as const;
export const MAX_JSON_ASSERTIONS = 10;
export const NOT_JSON = "Response is not valid JSON";

type Step = string | number;

/** The steps of a path, or an error message. A leading `$` is optional. */
export function parsePath(path: string): Step[] | string {
  const steps: Step[] = [];
  let i = path.startsWith("$") ? 1 : 0;
  const ident = (from: number) => { let j = from; while (j < path.length && path[j] !== "." && path[j] !== "[" && path[j] !== "]") j++; return j; };
  if (i === 0 && path.length && path[0] !== "[" && path[0] !== ".") { const j = ident(0); steps.push(path.slice(0, j)); i = j; }
  while (i < path.length) {
    if (path[i] === ".") {
      const j = ident(i + 1);
      if (j === i + 1) return `Empty key at position ${i + 1}`;
      steps.push(path.slice(i + 1, j));
      i = j;
    } else if (path[i] === "[") {
      const q = path[i + 1];
      if (q === '"' || q === "'") {
        const end = path.indexOf(q + "]", i + 2);
        if (end < 0) return `Unclosed quoted key at position ${i}`;
        steps.push(path.slice(i + 2, end));
        i = end + 2;
      } else {
        const end = path.indexOf("]", i);
        const n = path.slice(i + 1, end);
        if (end < 0 || !/^\d{1,6}$/.test(n)) return `Expected an array index at position ${i}`;
        steps.push(Number(n));
        i = end + 1;
      }
    } else return `Unexpected "${path[i]}" at position ${i}`;
  }
  return steps;
}

export const jsonAssertionSchema = z.object({
  path: z.string().trim().min(1).max(256).superRefine((p, ctx) => { const r = parsePath(p); if (typeof r === "string") ctx.addIssue({ code: "custom", message: r }); }),
  op: z.enum(JSON_ASSERT_OPS),
  value: z.string().max(500).default(""),
});
export const jsonAssertionsSchema = z.array(jsonAssertionSchema).max(MAX_JSON_ASSERTIONS);

const MISSING = Symbol("missing");
function lookup(doc: unknown, steps: Step[]): unknown {
  let cur: unknown = doc;
  for (const s of steps) {
    if (typeof s === "number") { if (!Array.isArray(cur) || s >= cur.length) return MISSING; cur = cur[s]; }
    else { if (!cur || typeof cur !== "object" || Array.isArray(cur) || !Object.hasOwn(cur, s)) return MISSING; cur = (cur as Record<string, unknown>)[s]; }
  }
  return cur;
}

/** Whether a JSON value equals the text the user typed: `200` matches 200, `true` matches true, `null` matches null. */
function same(actual: unknown, want: string): boolean {
  if (typeof actual === "string") return actual === want;
  if (typeof actual === "number") return want.trim() !== "" && Number(want) === actual;
  if (typeof actual === "boolean" || actual === null) return String(actual) === want.trim();
  try { return JSON.stringify(actual) === JSON.stringify(JSON.parse(want)); } catch { return false; }
}

const show = (v: unknown) => { const s = v === MISSING ? "nothing" : JSON.stringify(v); return s.length > 80 ? s.slice(0, 77) + "..." : s; };

/** Why the body fails the first assertion it fails, or null when it passes them all. */
export function jsonAssertionProblem(body: string, assertions: JsonAssertion[]): string | null {
  let doc: unknown;
  try { doc = JSON.parse(body); } catch { return NOT_JSON; }
  for (const a of assertions) {
    const steps = parsePath(a.path);
    if (typeof steps === "string") return `Invalid JSON path ${a.path}: ${steps}`;
    const got = lookup(doc, steps);
    const found = got !== MISSING;
    let ok: boolean;
    switch (a.op) {
      case "exists": ok = found; break;
      case "not_exists": ok = !found; break;
      case "equals": ok = found && same(got, a.value); break;
      case "not_equals": ok = found && !same(got, a.value); break;
      case "contains": ok = typeof got === "string" ? got.includes(a.value) : Array.isArray(got) && got.some((x) => same(x, a.value)); break;
      case "greater_than":
      case "less_than": {
        const n = Number(a.value);
        ok = typeof got === "number" && a.value.trim() !== "" && Number.isFinite(n) && (a.op === "greater_than" ? got > n : got < n);
        break;
      }
    }
    if (!ok) {
      if (a.op === "exists") return `JSON ${a.path} is missing`;
      if (a.op === "not_exists") return `JSON ${a.path} is present (${show(got)})`;
      const words = { equals: "to equal", not_equals: "not to equal", contains: "to contain", greater_than: "to be greater than", less_than: "to be less than" }[a.op];
      return `Expected JSON ${a.path} ${words} ${JSON.stringify(a.value)}, got ${show(got)}`;
    }
  }
  return null;
}
