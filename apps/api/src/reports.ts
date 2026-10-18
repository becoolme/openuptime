import type { Repo } from "@openuptime/repo";
import { actionEmail, appUrl, sendEmail } from "./email";
import { unmetered, type Entitlements } from "./entitlements";
import { isLang, tr, type Lang } from "./mail-i18n";

/** The first days of a month, when the previous month's report goes out. An account that opts in later waits for the next one. */
export const REPORT_DAYS = 3;

/** YYYY-MM of the month before `now` (UTC). */
export function previousMonth(now: Date) {
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
  return d.toISOString().slice(0, 7);
}

const duration = (min: number, lang: Lang) => (min < 60 ? `${min} ${lang === "zh-CN" ? "分钟" : "min"}` : `${Math.floor(min / 60)} ${lang === "zh-CN" ? "小时" : "h"}${min % 60 ? ` ${min % 60} ${lang === "zh-CN" ? "分钟" : "min"}` : ""}`);

/**
 * Emails the owners of every workspace that turned the monthly report on a summary of last month. A workspace is claimed
 * for the month before anything is sent, so overlapping ticks cannot send twice; a send that fails is logged, not retried.
 */
export async function sendMonthlyReports(repo: Repo, now = new Date(), entitlements: Entitlements = unmetered) {
  if (now.getUTCDate() > REPORT_DAYS) return 0;
  const month = previousMonth(now);
  const [y, m] = month.split("-").map(Number);
  const from = new Date(Date.UTC(y, m - 1, 1));
  const to = new Date(Date.UTC(y, m, 1));
  let sent = 0;
  for (const orgId of await repo.claimMonthlyReports(month, 20)) {
    const [org, owners, comps] = await Promise.all([repo.organization(orgId), repo.ownerContacts(orgId), repo.monthlyReport(orgId, from, to)]);
    if (!org || !owners.length || !comps.length) continue;
    const granted = await entitlements.spendEmails(orgId, owners.length).catch(() => owners.length);
    for (const o of owners.slice(0, granted)) {
      const lang: Lang = isLang(o.locale) ? o.locale : "en";
      const title = tr(lang, "Monthly report for {month}", { month });
      const mail = actionEmail({
        title,
        body: tr(lang, "Uptime, downtime and incidents of each monitor in {workspace}.", { workspace: org.name }),
        rows: comps.map((c): [string, string] => [
          c.name,
          [c.uptime == null ? tr(lang, "No checks yet") : `${tr(lang, "Uptime")} ${c.uptime}%`, duration(c.downtimeMinutes, lang), `${tr(lang, "Incidents")} ${c.incidents}`].join(" · "),
        ]),
        cta: tr(lang, "Open dashboard"),
        url: `${appUrl()}/app`,
        footer: tr(lang, "You get this because the monthly report is turned on for {workspace}. Turn it off in Settings.", { workspace: org.name }),
        lang,
      });
      await sendEmail({ to: o.email, subject: `${title} · OpenUptime`, fromName: "OpenUptime", ...mail })
        .then(() => sent++)
        .catch((e) => console.error("monthly report failed", e));
    }
  }
  return sent;
}
