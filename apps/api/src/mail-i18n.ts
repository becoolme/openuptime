import type { Repo } from "@openuptime/repo";

export type Lang = "en" | "zh-CN";
export const isLang = (v: unknown): v is Lang => v === "en" || v === "zh-CN";

/** Language from an Accept-Language header (anything Chinese → zh-CN). */
export const langFromHeader = (h: string | null | undefined): Lang => (h?.toLowerCase().trim().startsWith("zh") ? "zh-CN" : "en");

const zh: Record<string, string> = {
  // generic
  "Sent by OpenUptime, open-source uptime monitoring.": "此邮件由 OpenUptime 发送，开源的可用性监控。",
  // alerts
  "Your channel is connected": "渠道已连通",
  "This is a test alert from OpenUptime. When a monitor goes down or recovers, you'll get a message like this one at this address.": "这是一封来自 OpenUptime 的测试告警。当监控宕机或恢复时，你会在这个地址收到类似的邮件。",
  "This is a test alert from OpenUptime": "这是一条来自 OpenUptime 的测试告警",
  "Down for {duration}": "宕机时长 {duration}",
  Test: "测试",
  "Open alerting": "打开告警设置",
  "Test alert from OpenUptime": "OpenUptime 测试告警",
  Monitor: "监控",
  Project: "项目",
  Target: "目标",
  Started: "开始时间",
  Error: "错误",
  Downtime: "宕机时长",
  Resolved: "恢复时间",
  Down: "宕机",
  Recovered: "已恢复",
  "{name}: domain expiry verified": "{name}：域名到期日已核实",
  "{name}: domain expiry unknown": "{name}：域名到期日未知",
  "{name}: registration date passed": "{name}：已过注册到期日",
  "{name}: domain renewal needed": "{name}：域名需要续期",
  "Time needing attention": "待处理时长",
  "Domain attention": "域名需处理",
  "Verified": "已核实",
  "{name} is down": "{name} 宕机了",
  "{name} has recovered": "{name} 已恢复",
  "{name} is still down": "{name} 仍然宕机",
  "{name} is still responding slowly": "{name} 仍然响应缓慢",
  "Nobody has acknowledged this incident yet. This is reminder {n} of {max}.": "这个事件还没有人确认。这是第 {n} 次提醒（最多 {max} 次）。",
  "Nobody acknowledged this incident in time, so it was escalated to this channel.": "这个事件没有及时被确认，因此升级通知到了此渠道。",
  "Verify your email address": "验证你的邮箱地址",
  "Confirm this address so we can reach you about your OpenUptime account and recover it if you lose access.": "确认此邮箱后，我们才能就你的 OpenUptime 账号联系你，并在你无法登录时帮你找回账号。",
  "Didn't create an OpenUptime account? Ignore this email.": "没有注册过 OpenUptime？忽略这封邮件即可。",
  "Verify email": "验证邮箱",
  "Verify your OpenUptime email": "验证你的 OpenUptime 邮箱",
  "{name} is responding slowly": "{name} 响应变慢",
  Slow: "变慢",
  "The monitor responded slower than its threshold on several checks in a row, so an incident was opened.": "该监控连续多次响应时间超过阈值，已自动创建事件。",
  "The monitor failed its consecutive checks, so an incident was opened.": "该监控连续检测失败，已自动创建事件。",
  "Checks are passing again and the incident is resolved.": "检测已恢复正常，事件已解决。",
  "View incident": "查看事件",
  "You get this because {name} is an alert channel in your workspace.": "你收到此邮件，是因为 {name} 是你工作区中的一个告警渠道。",
  "this email": "该邮箱",
  "Manage alerting": "管理告警",
  // status page subscribers
  "View status page": "查看状态页",
  "You receive this because you subscribed to updates from {title}.": "你收到此邮件，是因为你订阅了 {title} 的状态更新。",
  Unsubscribe: "退订",
  Investigating: "调查中",
  Identified: "已定位",
  Monitoring: "观察中",
  "Confirm your subscription to {title}": "确认订阅 {title}",
  "You will get an email when an incident is opened, updated or resolved. If this wasn’t you, ignore this message and you won’t be subscribed.": "当出现事件、事件更新或恢复时，你会收到邮件。如果不是你本人操作，忽略此邮件即可，不会产生订阅。",
  "Status updates from {title}. Powered by OpenUptime.": "来自 {title} 的状态更新，由 OpenUptime 提供。",
  "Status updates from {title}.": "来自 {title} 的状态更新。",
  "Confirm subscription": "确认订阅",
  "This address already gets incident emails. Use the button below if you want to stop them.": "此邮箱已在接收事件邮件。如果想停止接收，请点击下面的按钮。",
  "Scheduled maintenance: {name}": "计划维护：{name}",
  "Scheduled maintenance for {title} starts soon. Checks keep running, but alerts are paused while it lasts.": "{title} 的计划维护即将开始。检测会继续运行，但维护期间不会发送告警。",
  Starts: "开始",
  Ends: "结束",
  Scheduled: "已计划",
  "Monthly report for {month}": "{month} 月度报告",
  "Uptime for {month}": "{month} 可用性",
  "Uptime, downtime and incidents of each monitor in {workspace}.": "{workspace} 中每个监控项的可用率、停机时间和事件数。",
  Uptime: "可用率",
  Incidents: "事件",
  "No checks yet": "暂无检测",
  "Open dashboard": "打开控制台",
  "You get this because the monthly report is turned on for {workspace}. Turn it off in Settings.": "你收到此邮件，是因为 {workspace} 开启了月度报告。可在设置中关闭。",
  // account
  "Reset your password": "重置你的密码",
  "Reset your OpenUptime password": "重置你的 OpenUptime 密码",
  "Someone asked to reset the password for your OpenUptime account. If that wasn't you, ignore this email and nothing will change.": "有人请求重置你的 OpenUptime 账号密码。如果不是你本人操作，忽略此邮件即可，密码不会改变。",
  "Security email. You can't unsubscribe from these.": "安全邮件，无法退订。",
  "Choose a new password": "设置新密码",
  "Your password was changed": "你的密码已更改",
  "The password for your OpenUptime account was just changed with a reset link, and you were signed out on every device. If this was you, sign in again with the new password.\n\nIf it wasn't you, reset your password again now.": "你的 OpenUptime 账号密码刚刚通过重置链接更改，所有设备上的登录已退出。如果是你本人操作，请用新密码重新登录。\n\n如果不是你本人操作，请立即再次重置密码。",
  "Reset password again": "再次重置密码",
  "Your OpenUptime password was changed": "你的 OpenUptime 密码已更改",
  "Join {org} on OpenUptime": "加入 OpenUptime 上的 {org}",
  "{who} invited you to collaborate on {org}. You'll be able to see its monitors, incidents and status pages.": "{who} 邀请你协作管理 {org}。你将可以查看它的监控、事件和状态页。",
  Workspace: "工作区",
  "Invited by": "邀请人",
  "Valid until": "有效期至",
  "Not expecting this? Ignore this email and the invitation expires on its own.": "不是你期待的邮件？忽略即可，邀请会自动过期。",
  "Accept invitation": "接受邀请",
};

/** English text is the key (with `{var}` holes); zh-CN falls back to English for anything missing. */
export function tr(lang: Lang, key: string, vars: Record<string, string> = {}): string {
  const s = lang === "zh-CN" ? (zh[key] ?? key) : key;
  return s.replace(/\{(\w+)\}/g, (_, k: string) => vars[k] ?? "");
}

/** The language a person reads emails in: their account setting, or `fallback`. */
export async function userLang(repo: Repo, email: string, fallback: Lang = "en"): Promise<Lang> {
  const locale = await repo.localeByEmail(email);
  return isLang(locale) ? locale : fallback;
}

/** A workspace's default: its owner's language. Used for addresses that are not accounts (alert channels). */
export async function orgLang(repo: Repo, orgId: string): Promise<Lang> {
  const locale = await repo.ownerLocale(orgId);
  return isLang(locale) ? locale : "en";
}
