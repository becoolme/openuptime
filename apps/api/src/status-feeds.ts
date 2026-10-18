/**
 * Plain-text renderings of a public status page: the RSS feed, the maintenance calendar and llms.txt. Pure functions, so
 * escaping and limits are tested without a database. Every value that comes from a page owner is escaped for its format.
 */

export const FEED_LIMIT = 50;
export const ICS_LIMIT = 100;

/** Characters XML 1.0 cannot carry at all are dropped; the rest of the markup characters are escaped. */
export const xmlEscape = (s: string) =>
  s
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]/g, "")
    .replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" })[ch]!);

export type FeedIncident = { id: string; title: string; status: string; startedAt: Date | string; updates: { body: string; status: string }[] };
export type FeedWindow = { id: string; name: string; startsAt: Date; endsAt: Date };

const iso = (d: Date | string) => new Date(d).toISOString();
const stamp = (d: Date) => iso(d).replace(/[-:]/g, "").replace(/\.\d{3}/, "");
const minutes = (d: Date) => iso(d).slice(0, 16).replace("T", " ") + " UTC";

/** RSS 2.0 with the latest incidents and maintenance windows together, newest first; titles say which kind each item is. */
export function buildRss(o: { title: string; link: string; incidents: FeedIncident[]; maintenance: FeedWindow[]; now?: Date }) {
  const items = [
    ...o.incidents.map((i) => ({
      at: new Date(i.startedAt),
      guid: `incident-${i.id}`,
      title: `[Incident] ${i.title} (${i.status})`,
      description: i.updates.map((u) => `[${u.status}] ${u.body}`).join("\n") || i.title,
    })),
    ...o.maintenance.map((w) => ({
      at: w.startsAt,
      guid: `maintenance-${w.id}`,
      title: `[Maintenance] ${w.name}`,
      description: `Scheduled maintenance: ${minutes(w.startsAt)} to ${minutes(w.endsAt)}.`,
    })),
  ]
    .sort((a, b) => b.at.getTime() - a.at.getTime())
    .slice(0, FEED_LIMIT);
  const x = xmlEscape;
  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"><channel><title>${x(o.title)} status</title><link>${x(o.link)}</link><description>${x(`Incidents and scheduled maintenance for ${o.title}`)}</description>
${items
  .map((i) => `<item><title>${x(i.title)}</title><link>${x(o.link)}</link><guid isPermaLink="false">${x(i.guid)}</guid><pubDate>${i.at.toUTCString()}</pubDate><description>${x(i.description)}</description></item>`)
  .join("\n")}
</channel></rss>`;
}

/** iCalendar TEXT escaping (RFC 5545 §3.3.11); CR and other control characters are dropped. */
export const icsEscape = (s: string) =>
  s
    .replace(/[\u0000-\u0008\u000B-\u001F\u007F]/g, (c) => (c === "\n" ? c : ""))
    .replace(/\\/g, "\\\\")
    .replace(/;/g, "\\;")
    .replace(/,/g, "\\,")
    .replace(/\n/g, "\\n");

/** Content lines are folded at 75 octets, continuation lines start with one space; never inside a UTF-8 sequence. */
export function icsFold(line: string) {
  const enc = new TextEncoder();
  const out: string[] = [];
  let cur = "";
  let bytes = 0;
  let limit = 75;
  for (const ch of line) {
    const n = enc.encode(ch).length;
    if (bytes + n > limit) {
      out.push(cur);
      cur = " ";
      bytes = 1;
      limit = 75;
    }
    cur += ch;
    bytes += n;
  }
  out.push(cur);
  return out.join("\r\n");
}

/** A calendar of a page's maintenance windows; subscribe to it and the windows appear in any calendar app. */
export function buildIcs(o: { title: string; link: string; host: string; windows: FeedWindow[]; now?: Date }) {
  const now = o.now ?? new Date();
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//OpenUptime//Status page maintenance//EN",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    `X-WR-CALNAME:${icsEscape(`${o.title} maintenance`)}`,
    "REFRESH-INTERVAL;VALUE=DURATION:PT1H",
    ...o.windows.slice(0, ICS_LIMIT).flatMap((w) => [
      "BEGIN:VEVENT",
      `UID:${w.id}@${o.host.replace(/[^a-zA-Z0-9.-]/g, "")}`,
      `DTSTAMP:${stamp(now)}`,
      `DTSTART:${stamp(w.startsAt)}`,
      `DTEND:${stamp(w.endsAt)}`,
      `SUMMARY:${icsEscape(`Maintenance: ${w.name}`)}`,
      `DESCRIPTION:${icsEscape(`Scheduled maintenance for ${o.title}. Monitoring continues but alerts are paused.`)}`,
      `URL:${icsEscape(o.link)}`,
      "END:VEVENT",
    ]),
    "END:VCALENDAR",
  ];
  return lines.map(icsFold).join("\r\n") + "\r\n";
}

/** The shape anyone (a person or an agent) can read at /status/<slug>/llms.txt: short, factual, no marketing. */
export function buildLlmsTxt(o: {
  title: string;
  link: string;
  api: string;
  overall: string;
  components: { name: string; status: string; uptime90d: number | null }[];
  incidents: { title: string; status: string }[];
  maintenance: { name: string; startsAt: Date; endsAt: Date }[];
  /** URL of the credential-free MCP endpoint, when the page allows it */
  mcp: string | null;
}) {
  const line = (s: string) => s.replace(/\s+/g, " ").trim();
  return (
    [
      `# ${line(o.title)} status`,
      "",
      `> Public status page. Overall state right now: ${o.overall}.`,
      "",
      "## Components",
      ...(o.components.length ? o.components.map((c) => `- ${line(c.name)}: ${c.status}${c.uptime90d == null ? "" : `, ${c.uptime90d}% uptime over 90 days`}`) : ["- none"]),
      "",
      "## Active incidents",
      ...(o.incidents.length ? o.incidents.map((i) => `- ${line(i.title)} (${i.status})`) : ["- none"]),
      "",
      "## Upcoming maintenance",
      ...(o.maintenance.length ? o.maintenance.map((w) => `- ${line(w.name)}: ${minutes(w.startsAt)} to ${minutes(w.endsAt)}`) : ["- none"]),
      "",
      "## Machine-readable",
      `- [Page](${o.link})`,
      `- [JSON summary](${o.api}/summary)`,
      `- [Full status as JSON](${o.api})`,
      `- [Incident history](${o.api}/incidents)`,
      `- [RSS feed](${o.api}/rss.xml)`,
      `- [Maintenance calendar](${o.api}/maintenance.ics)`,
      ...(o.mcp ? [`- Read-only MCP endpoint, no credentials needed: ${o.mcp} (tools: status_page_overview, status_page_incidents, status_page_maintenance; pass slug)`] : []),
    ].join("\n") + "\n"
  );
}
