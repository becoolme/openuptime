/**
 * Which HTTP statuses count as healthy, written as a short list: single codes (`200`), ranges (`200-299`), classes
 * (`2xx`), and the same prefixed with `!` to exclude them (`!204`). A status is accepted when it matches an included
 * item and no excluded one; a list of exclusions only accepts everything else (`!5xx`).
 */

/** Probes that understand `acceptedStatuses` advertise this; an older probe would silently check `expectedStatus` instead. */
export const STATUS_SPEC_CAPABILITY = "status-spec-v1";
export const MAX_STATUS_SPEC_LENGTH = 200;
export const MAX_STATUS_SPEC_ITEMS = 20;

type Range = readonly [number, number];
export type StatusSpec = { include: Range[]; exclude: Range[] };

const ITEM = /^(!?)(?:([1-5])xx|(\d{3})(?:-(\d{3}))?)$/i;
const MIN = 100, MAX = 599;

/** The parsed list, or why it cannot be used. */
export function parseStatusSpec(raw: string): { spec: StatusSpec; normalized: string } | { error: string } {
  if (raw.length > MAX_STATUS_SPEC_LENGTH) return { error: `Use at most ${MAX_STATUS_SPEC_LENGTH} characters` };
  const items = raw.split(",").map((s) => s.trim()).filter(Boolean);
  if (!items.length) return { error: "List at least one status, such as 200-299" };
  if (items.length > MAX_STATUS_SPEC_ITEMS) return { error: `Use at most ${MAX_STATUS_SPEC_ITEMS} items` };
  const spec: StatusSpec = { include: [], exclude: [] };
  const out: string[] = [];
  for (const item of items) {
    const m = ITEM.exec(item.replace(/\s+/g, ""));
    if (!m) return { error: `"${item}" is not a status, a range like 200-299 or a class like 2xx` };
    const [, not, cls, from, to] = m;
    let range: Range;
    if (cls) range = [Number(cls) * 100, Number(cls) * 100 + 99];
    else {
      const a = Number(from), b = to === undefined ? a : Number(to);
      if (a < MIN || b > MAX) return { error: `"${item}" is outside ${MIN}-${MAX}` };
      if (a > b) return { error: `"${item}" runs backwards; write the lower status first` };
      range = [a, b];
    }
    (not ? spec.exclude : spec.include).push(range);
    out.push(`${not}${cls ? `${cls}xx` : to === undefined ? from : `${from}-${to}`}`);
  }
  if (!spec.include.length) spec.include.push([MIN, MAX]);
  let any = false;
  for (let s = MIN; s <= MAX && !any; s++) any = statusAccepted(spec, s);
  if (!any) return { error: "The exclusions leave no status that would count as healthy" };
  return { spec, normalized: out.join(",") };
}

const within = (rs: Range[], s: number) => rs.some(([a, b]) => s >= a && s <= b);
export const statusAccepted = (spec: StatusSpec, status: number) => within(spec.include, status) && !within(spec.exclude, status);

/** The rule a monitor checks with: its list when it has one, else the single expected status (200 also takes any 2xx). */
export function statusRule(m: { expectedStatus: number; acceptedStatuses?: string | null }): StatusSpec {
  if (m.acceptedStatuses) {
    const parsed = parseStatusSpec(m.acceptedStatuses);
    if ("spec" in parsed) return parsed.spec;
  }
  return m.expectedStatus === 200 ? { include: [[200, 299]], exclude: [] } : { include: [[m.expectedStatus, m.expectedStatus]], exclude: [] };
}

/** How the rule reads in an error message: the list as written, or the single status. */
export const statusRuleText = (m: { expectedStatus: number; acceptedStatuses?: string | null }) => m.acceptedStatuses || String(m.expectedStatus);
