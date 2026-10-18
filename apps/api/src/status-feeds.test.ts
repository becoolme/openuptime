import { describe, expect, it } from "vitest";
import { buildIcs, buildLlmsTxt, buildRss, FEED_LIMIT, icsEscape, icsFold, ICS_LIMIT, xmlEscape } from "./status-feeds";

const nasty = `A & B <i>"q"</i> 'z'`;
const at = (n: number) => new Date(Date.UTC(2026, 0, 1) + n * 6e4);

describe("status page feeds", () => {
  it("escapes every markup character and drops control characters", () => {
    expect(xmlEscape(nasty)).toBe("A &amp; B &lt;i&gt;&quot;q&quot;&lt;/i&gt; &apos;z&apos;");
    expect(xmlEscape("a\u0000b\u0008c")).toBe("abc");
  });

  it("builds RSS with kind prefixes and escaped owner text everywhere", () => {
    const xml = buildRss({
      title: nasty,
      link: "https://x.example/status/a?b=1&c=2",
      incidents: [{ id: "i1", title: nasty, status: "resolved", startedAt: at(2), updates: [{ body: "<b>x</b> & y", status: "resolved" }] }],
      maintenance: [{ id: "m1", name: nasty, startsAt: at(5), endsAt: at(65) }],
    });
    expect(xml).toContain("[Incident] A &amp; B");
    expect(xml).toContain("[Maintenance] A &amp; B");
    expect(xml).toContain("b=1&amp;c=2");
    expect(xml).not.toMatch(/<b>|<i>/);
    expect(xml.indexOf("[Maintenance]")).toBeLessThan(xml.indexOf("[Incident]")); // newest first
  });

  it("caps the feed at 50 items across both kinds", () => {
    const incidents = Array.from({ length: 40 }, (_, n) => ({ id: `i${n}`, title: `I${n}`, status: "resolved", startedAt: at(n), updates: [] }));
    const maintenance = Array.from({ length: 40 }, (_, n) => ({ id: `m${n}`, name: `M${n}`, startsAt: at(100 + n), endsAt: at(200 + n) }));
    const xml = buildRss({ title: "t", link: "https://x.example", incidents, maintenance });
    expect(xml.match(/<item>/g)).toHaveLength(FEED_LIMIT);
  });

  it("escapes calendar text, folds long lines at 75 octets and caps the number of events", () => {
    expect(icsEscape("a;b,c\\d\ne\r")).toBe("a\\;b\\,c\\\\d\\ne");
    const folded = icsFold("X:" + "é".repeat(100)).split("\r\n");
    expect(folded.length).toBeGreaterThan(1);
    for (const l of folded) expect(new TextEncoder().encode(l).length).toBeLessThanOrEqual(75);
    expect(folded.slice(1).every((l) => l.startsWith(" "))).toBe(true);
    const windows = Array.from({ length: ICS_LIMIT + 20 }, (_, n) => ({ id: `w${n}`, name: n === 0 ? "a\r\nEND:VCALENDAR" : "w", startsAt: at(n), endsAt: at(n + 30) }));
    const ics = buildIcs({ title: "T", link: "https://x.example", host: "x.example", windows, now: at(0) });
    expect(ics.match(/BEGIN:VEVENT/g)).toHaveLength(ICS_LIMIT);
    expect(ics.split("\r\n").filter((l) => l === "END:VCALENDAR")).toHaveLength(1); // the injected text stays inside one escaped line
    expect(ics).toContain("DTSTART:20260101T000000Z");
    expect(ics.endsWith("\r\n")).toBe(true);
  });

  it("writes a short llms.txt, mentioning MCP only when it is on", () => {
    const base = { title: "Acme", link: "https://x.example/status/a", api: "https://x.example/api/public/status/a", overall: "Operational", components: [{ name: "API", status: "up", uptime90d: 99.95 }], incidents: [], maintenance: [] };
    const on = buildLlmsTxt({ ...base, mcp: "https://x.example/api/mcp/public" });
    expect(on).toContain("API: up, 99.95% uptime over 90 days");
    expect(on).toContain("/api/mcp/public");
    expect(buildLlmsTxt({ ...base, mcp: null })).not.toContain("mcp");
  });
});
