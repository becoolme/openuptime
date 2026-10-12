import { describe, expect, it } from "vitest";
import type { ChangelogEntry } from "./changelog";
import { ENTRIES, sortEntries } from "./changelog-list";

const entry = (id: string, date: string, edition: ChangelogEntry["edition"] = "community"): ChangelogEntry => ({
  id,
  date,
  edition,
  title: { en: id, zh: id },
  summary: { en: "s", zh: "s" },
  points: [],
});

describe("sortEntries", () => {
  it("puts the newest day first and keeps the given order within a day", () => {
    const sorted = sortEntries([entry("a", "2026-10-11"), entry("b", "2026-10-12")], [entry("c", "2026-10-11", "cloud")]);
    expect(sorted.map((e) => e.id)).toEqual(["b", "a", "c"]);
  });
});

describe("the changelog", () => {
  it("has unique ids and real dates", () => {
    const ids = ENTRIES.map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const e of ENTRIES) expect(e.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
  it("is written in both languages", () => {
    for (const e of ENTRIES) {
      const strings = [e.title, e.summary, ...e.points, ...(e.cloud ? [e.cloud] : []), ...(e.link ? [e.link.label] : [])];
      for (const s of strings) {
        expect(s.en.trim()).not.toBe("");
        expect(s.zh.trim()).not.toBe("");
      }
    }
  });
  it("is newest first", () => {
    const dates = ENTRIES.map((e) => e.date);
    expect(dates).toEqual([...dates].sort().reverse());
  });
});
