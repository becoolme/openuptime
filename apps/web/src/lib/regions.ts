/** `auto` is the scheduler's own location: the region a monitor has until the user picks others. */
export const AUTO = "auto";

/**
 * The selection after the user toggles `id`. `auto` counts toward the plan's limit like any region, so:
 *  - the first real region picked replaces `auto` instead of being added to it;
 *  - on a plan that allows one region, picking another replaces the current one;
 *  - on a larger plan a full selection stays as it is until something is switched off;
 *  - switching the last one off falls back to `auto`.
 */
export function toggleRegion(current: string[], id: string, max: number): string[] {
  let next: string[];
  if (current.includes(id)) next = current.filter((x) => x !== id);
  else if (current.length === 1 && current[0] === AUTO) next = [id];
  else if (current.length >= max) next = max <= 1 ? [id] : current;
  else next = [...current, id];
  return next.length ? next : [AUTO];
}

/** Can `id` be switched on? Only a full multi-region selection locks the remaining options. */
export function regionLocked(current: string[], id: string, max: number): boolean {
  return max > 1 && !current.includes(id) && current.length >= max && !(current.length === 1 && current[0] === AUTO);
}
