/** Both languages of a string on the changelog page. */
export interface L {
  en: string;
  zh: string;
}

/**
 * `community` entries ship in the open-source edition (the `main` branch) and therefore in Cloud as well.
 * `cloud` entries exist only in the hosted edition (the `cloud` branch) and live in changelog-cloud.ts.
 */
export type Edition = "community" | "cloud";

export interface ChangelogEntry {
  /** anchor, unique across both lists */
  id: string;
  /** YYYY-MM-DD */
  date: string;
  edition: Edition;
  title: L;
  summary: L;
  points: L[];
  /** what the same change means on the hosted service, for a community entry */
  cloud?: L;
  link?: { href: string; label: L };
}

/** Community entries, newest first within a day. Cloud-only entries are added by changelog-cloud.ts. */
export const COMMUNITY_ENTRIES: ChangelogEntry[] = [
  {
    id: "multi-region-checks",
    date: "2026-10-12",
    edition: "community",
    title: { en: "Check from several regions", zh: "多区域检测" },
    summary: {
      en: "A monitor can be checked from more than one place, so a bad route does not look like your site being down.",
      zh: "一个监控项可以从多个地区发起检测，某条线路出问题时不会被误判为站点宕机。",
    },
    points: [
      {
        en: "Pick regions per HTTP or TCP monitor. A run fails when most of the regions that answered failed; a probe that cannot be reached is left out of the vote.",
        zh: "为 HTTP 或 TCP 监控项选择检测地区。多数已应答地区失败才判定本次失败；无法连通的探针不参与投票。",
      },
      {
        en: "Probes run as a Docker image, a plain Node server or on Vercel, and there is a new Multi-region checks docs page.",
        zh: "探针可作为 Docker 镜像、Node 服务或在 Vercel 上运行，并新增了「多区域检测」文档页。",
      },
      {
        en: "The monitor page shows one multi-region check as one run, with uptime and latency for each region.",
        zh: "监控详情页把一次多区域检测显示为一次运行，并给出各地区的可用率与延迟。",
      },
      {
        en: "With no plan there is no limit on regions per monitor.",
        zh: "没有套餐限制时，每个监控项可使用的地区数量不设上限。",
      },
    ],
    cloud: {
      en: "Five hosted regions: us-east, us-west, eu-central, ap-southeast and ap-northeast. Free checks from one region, Lite and Starter from up to three, Team from up to five. Each region counts as one check.",
      zh: "托管 5 个地区：us-east、us-west、eu-central、ap-southeast、ap-northeast。Free 可选 1 个，Lite 与 Starter 最多 3 个，Team 最多 5 个。每个地区计 1 次检测。",
    },
    link: { href: "/docs/regions", label: { en: "Read the multi-region docs", zh: "阅读多区域检测文档" } },
  },
  {
    id: "security-hardening",
    date: "2026-10-11",
    edition: "community",
    title: { en: "Security hardening", zh: "安全加固" },
    summary: {
      en: "A pass over the API ahead of the open-source release.",
      zh: "开源发布前对 API 做的一轮安全加固。",
    },
    points: [
      { en: "Private and internal check targets are refused by default.", zh: "默认拒绝检测私有网络与内部地址。" },
      {
        en: "Channel credentials and monitor headers are hidden from people who cannot manage them.",
        zh: "通知渠道的凭据与监控项请求头，对无管理权限的成员隐藏。",
      },
      {
        en: "Sign-in and sign-up endpoints are rate limited, and email sign-up can use Cloudflare Turnstile.",
        zh: "登录与注册接口增加频率限制，邮箱注册可启用 Cloudflare Turnstile。",
      },
      { en: "Destructive and configuration changes need an owner or admin.", zh: "删除与配置类操作需要所有者或管理员权限。" },
      {
        en: "At most one automatic incident is open per monitor and kind, and each incident is resolved once.",
        zh: "每个监控项的每种事件类型最多同时存在一个自动事件，且每个事件只会被恢复一次。",
      },
    ],
  },
  {
    id: "open-source-release",
    date: "2026-10-11",
    edition: "community",
    title: { en: "Open-source release", zh: "开源发布" },
    summary: {
      en: "OpenUptime is MIT licensed and runs without limits on your own infrastructure.",
      zh: "OpenUptime 以 MIT 协议开源，可在你自己的基础设施上无限制运行。",
    },
    points: [
      {
        en: "One Edition interface decides what a workspace may use; the community edition is unmetered.",
        zh: "通过统一的 Edition 接口决定工作区可用的额度；社区版不计量、不设限。",
      },
      {
        en: "README, a docs index, and self-host guides for Cloudflare and Docker.",
        zh: "新增 README、文档索引，以及 Cloudflare 与 Docker 的自托管指南。",
      },
    ],
    link: { href: "/docs/self-host", label: { en: "Self-host guide", zh: "自托管指南" } },
  },
  {
    id: "workspace-switching",
    date: "2026-10-11",
    edition: "community",
    title: { en: "Smaller improvements", zh: "细节改进" },
    summary: { en: "Fixes and polish around the app.", zh: "应用内的若干修复与打磨。" },
    points: [
      { en: "Switch workspace or project without reloading the page.", zh: "切换工作区或项目时不再刷新页面。" },
      { en: "MCP sign-in no longer fails when a token is refreshed.", zh: "修复 MCP 授权在刷新令牌时失败的问题。" },
    ],
  },
];
