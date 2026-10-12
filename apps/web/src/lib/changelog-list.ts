import { COMMUNITY_ENTRIES, type ChangelogEntry } from "./changelog";
import { CLOUD_ENTRIES } from "./changelog-cloud";

/** Every entry of this build, newest day first; within a day the list order is kept (community before cloud). */
export function sortEntries(...lists: ChangelogEntry[][]): ChangelogEntry[] {
  return lists.flat().sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
}

export const ENTRIES = sortEntries(COMMUNITY_ENTRIES, CLOUD_ENTRIES);
