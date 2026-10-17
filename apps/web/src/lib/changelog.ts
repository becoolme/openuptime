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
    id: "prober-self-check",
    date: "2026-10-17",
    edition: "community",
    title: { en: "No false outages when the checker is offline", zh: "检测端断网时不再误报故障" },
    summary: {
      en: "When a check fails to connect, OpenUptime first makes sure the machine running it can reach the internet, and discards the result if it cannot.",
      zh: "检测连接失败时,OpenUptime 会先确认执行检测的机器自身能上网;如果不能,就丢弃这次结果。",
    },
    points: [
      { en: "A network failure on the checker's side no longer counts as a failed check, opens an incident or sends an alert.", zh: "检测端自身的网络故障不再计为失败检测,也不会创建事件或发送告警。" },
      { en: "A region whose probe is offline is left out of the run instead of voting the monitor down.", zh: "探测节点自身离线时,该区域不再参与表决,不会把监控判为故障。" },
      { en: "Errors that only the checker's own network can cause, such as a missing IPv6 route, are no longer blamed on your service.", zh: "只可能由检测端自身网络引起的错误(例如没有 IPv6 路由)不再算到你的服务头上。" },
      { en: "Monitors on private addresses are not affected, since they do not depend on the public internet.", zh: "监控内网地址的监控项不受影响,因为它们不依赖公网。" },
    ],
  },
  {
    id: "docker-scheduler-watchdog",
    date: "2026-10-17",
    edition: "community",
    title: { en: "Self-hosted restarts a stuck scheduler", zh: "自托管调度卡死时自动重启" },
    summary: {
      en: "A self-hosted container now restarts itself if the check scheduler hangs, instead of silently stopping checks.",
      zh: "自托管容器在检测调度卡死时会自动重启,不再悄悄停止检测。",
    },
    points: [
      { en: "If one scheduling round runs for more than five minutes, for example on a hung database call, the process exits and Docker's restart policy starts it again.", zh: "如果某一轮调度运行超过五分钟(例如数据库调用卡住),进程会退出,由 Docker 的重启策略重新拉起。" },
      { en: "Rounds that fail quickly, such as during a database outage, are unaffected and retry on the next round.", zh: "快速失败的调度(例如数据库故障期间)不受影响,下一轮会重试。" },
    ],
  },
  {
    id: "ios-testflight-beta",
    date: "2026-10-17",
    edition: "community",
    title: { en: "iOS app in public beta", zh: "iOS 应用公开测试" },
    summary: {
      en: "The OpenUptime iOS app is in public beta on TestFlight.",
      zh: "OpenUptime iOS 应用现已通过 TestFlight 公开测试。",
    },
    points: [
      { en: "Join the beta from the iOS page with one tap on TestFlight.", zh: "在 iOS 页面点一下即可通过 TestFlight 加入测试。" },
    ],
    link: { href: "/ios", label: { en: "Join the iOS beta", zh: "加入 iOS 测试" } },
  },
  {
    id: "not-found-page",
    date: "2026-10-16",
    edition: "community",
    title: { en: "A friendlier 404 page", zh: "更友好的 404 页面" },
    summary: {
      en: "A link that leads nowhere now shows a short page styled like a status board, with a way back.",
      zh: "打不开的链接现在会显示一个状态板风格的简短页面，并给出返回的路径。",
    },
    points: [
      { en: "The page shows the address that was not found and links back to the home page and to the services list.", zh: "页面会显示未找到的地址，并提供回到首页和服务列表的链接。" },
    ],
  },
  {
    id: "faster-status-pages",
    date: "2026-10-16",
    edition: "community",
    title: { en: "Faster public status pages", zh: "更快的公开状态页" },
    summary: {
      en: "Public status pages load faster, including when you self-host with Docker.",
      zh: "公开状态页加载更快，自托管（Docker）部署同样适用。",
    },
    points: [
      {
        en: "A status page and its incident history are now read at the same time, and a page is served from a short-lived copy instead of being worked out again on every visit. The copy lives in memory, and on Cloudflare Workers it is also shared through the data centre's cache.",
        zh: "状态页与事件历史现在同时读取，页面内容会短暂保留一份副本，不必每次访问都重新计算。副本保存在内存中；在 Cloudflare Workers 上还会通过机房缓存共享。",
      },
      {
        en: "Changes you make to a status page show up on the public page within 30 seconds.",
        zh: "对状态页的修改会在 30 秒内显示到公开页面上。",
      },
      {
        en: "A page that is not in the cache is built with fewer database round trips, so the first visit is quicker, and the days in each uptime bar now always come in date order.",
        zh: "缓存未命中的页面减少了数据库往返次数，首次访问更快；每条可用率柱状图中的日期现在始终按时间排序。",
      },
    ],
  },
  {
    id: "mcp-registry",
    date: "2026-10-15",
    edition: "community",
    title: { en: "Listed in the MCP Registry", zh: "收录到 MCP Registry" },
    summary: {
      en: "The OpenUptime MCP server can now be found in the official MCP Registry as app.openuptime/mcp.",
      zh: "OpenUptime 的 MCP 服务现在可以在官方 MCP Registry 中以 app.openuptime/mcp 找到。",
    },
    points: [
      { en: "The MCP docs gain example prompts and a troubleshooting section for authorization and scope problems.", zh: "MCP 文档新增示例提示词，以及授权和范围问题的排错说明。" },
      { en: "An agent skill for the common workflows installs with npx skills add becoolme/openuptime.", zh: "常见流程的 Agent 技能可用 npx skills add becoolme/openuptime 安装。" },
      { en: "The repository ships a server.json describing the server, and the README explains how to connect.", zh: "仓库新增描述该服务的 server.json，README 也补充了接入方式。" },
    ],
    link: { href: "/docs/mcp", label: { en: "Read the MCP docs", zh: "阅读 MCP 文档" } },
  },
  {
    id: "verify-bar-no-resend",
    date: "2026-10-15",
    edition: "community",
    title: { en: "No duplicate verification emails", zh: "不再重复发送验证邮件" },
    summary: {
      en: "The email verification banner no longer offers a resend button right after sign-up.",
      zh: "注册后的邮箱验证提示条不再显示“发送验证邮件”按钮。",
    },
    points: [
      { en: "The verification email is sent automatically at sign-up, so the banner only tells you where it went. You can still request a new one from the Account page.", zh: "验证邮件会在注册时自动发送，提示条只告知发送到哪个邮箱，避免重复点击多发一封；仍可在“账号”页重新发送。" },
    ],
  },
  {
    id: "ios-app-page",
    date: "2026-10-14",
    edition: "community",
    title: { en: "iOS app page", zh: "iOS 应用页面" },
    summary: {
      en: "The website now has a page for the OpenUptime iOS app, linked from the footer.",
      zh: "网站新增 iOS 应用页面，并在页脚提供入口。",
    },
    points: [
      { en: "The page says what the app does and shows where to install it, or that it is coming soon.", zh: "页面介绍应用的功能，并给出安装入口；尚未发布时显示“即将上线”。" },
    ],
    link: { href: "/ios", label: { en: "See the iOS app page", zh: "查看 iOS 应用页面" } },
  },
  {
    id: "push-notifications-ios",
    date: "2026-10-14",
    edition: "community",
    title: { en: "Push alerts to the iOS app", zh: "iOS 应用推送告警" },
    summary: {
      en: "Alerts can now arrive as push notifications on the phones of your workspace members.",
      zh: "告警现在可以作为推送通知，发送到工作区成员的手机上。",
    },
    points: [
      { en: "Add a Mobile app (push) channel and every member who signed in on the app gets down and recovery alerts, in their own language.", zh: "添加“手机 App 推送”渠道后，在应用中登录过的每位成员都会收到宕机与恢复告警，并使用各自的语言。" },
      { en: "The first phone an owner or admin registers creates the channel for the workspace, so alerts start without any setup.", zh: "所有者或管理员注册第一台手机时会自动为工作区创建该渠道，无需额外设置。" },
      { en: "Self-hosted servers need their own Apple push key; the setup is described in the self-hosting guide.", zh: "自托管服务器需要配置自己的 Apple 推送密钥，步骤见自托管指南。" },
    ],
    cloud: { en: "Push is set up on the hosted service; nothing to configure.", zh: "托管服务已配置好推送，无需设置。" },
    link: { href: "/docs/self-host#apns", label: { en: "Read the push setup guide", zh: "阅读推送配置指南" } },
  },
  {
    id: "api-key-qr-code",
    date: "2026-10-14",
    edition: "community",
    title: { en: "Connect the mobile app with a QR code", zh: "用二维码连接移动应用" },
    summary: {
      en: "A new API key now comes with a QR code that the mobile app can scan.",
      zh: "新建 API 密钥后会同时显示二维码，移动应用扫一下即可连接。",
    },
    points: [
      { en: "The code carries this server's address and the new key, shown once with the key, so keep it private.", zh: "二维码包含此服务器地址和新密钥，与密钥一起只显示一次，请勿外传。" },
    ],
  },
  {
    id: "email-takeover-protection",
    date: "2026-10-14",
    edition: "community",
    title: { en: "Protection for unverified email accounts", zh: "未验证邮箱账号保护" },
    summary: {
      en: "Signing in with GitHub now clears any password someone else set on an unverified account with your email.",
      zh: "用 GitHub 登录时，会清除他人在使用你邮箱的未验证账号上设置的密码。",
    },
    points: [
      { en: "The password, sessions, API keys and two-factor setup on that account are removed, so only you can use it.", zh: "该账号上的密码、会话、API 密钥和两步验证设置都会被移除，只有你能使用它。" },
      { en: "You can sign in with GitHub even when someone registered your email before you.", zh: "即使有人比你先用你的邮箱注册，你也可以用 GitHub 登录。" },
    ],
  },
  {
    id: "github-sign-in-and-linking",
    date: "2026-10-14",
    edition: "community",
    title: { en: "Sign in with GitHub and connect it to your account", zh: "GitHub 登录与账号关联" },
    summary: {
      en: "GitHub can be connected to an existing account, and the mobile app can sign in with it.",
      zh: "可以把 GitHub 关联到现有账号，移动应用也能用它登录。",
    },
    points: [
      { en: "Account has a Connected accounts block to connect or disconnect GitHub, even when its email differs from yours.", zh: "账号页新增“已关联的账号”，可关联或取消关联 GitHub，GitHub 邮箱可以与账号邮箱不同。" },
      { en: "The last way to sign in cannot be disconnected, and a GitHub address is only matched to an existing account when GitHub reports it as verified.", zh: "最后一种登录方式无法取消关联；只有 GitHub 报告邮箱已验证时，才会按邮箱匹配已有账号。" },
      { en: "Native apps can finish GitHub sign-in with a single-use token that is valid for 60 seconds; /api/config reports it as auth.nativeHandoff.", zh: "原生应用可用有效期 60 秒、只能使用一次的令牌完成 GitHub 登录；/api/config 以 auth.nativeHandoff 报告该能力。" },
      { en: "Accounts that signed up with GitHub have no password: Connected accounts explains how to set one through the forgot-password email, and deleting the account no longer asks for it, only a recent sign-in.", zh: "用 GitHub 注册的账号没有密码：已关联账号卡片说明可通过“忘记密码”邮件设置密码，删除账号也不再要求输入密码，只需最近登录过。" },
      { en: "After connecting, a confirmation appears and the card shows which GitHub account is linked.", zh: "关联完成后会提示成功，卡片上显示已关联的 GitHub 账号。" },
      { en: "Self-hosting docs now explain how to create the GitHub OAuth App, the callback URL and troubleshooting.", zh: "自托管文档新增 GitHub OAuth App 的创建方法、回调地址和排错说明。" },
    ],
    link: { href: "/docs/self-host#github", label: { en: "Read the GitHub sign-in setup", zh: "阅读 GitHub 登录配置" } },
  },
  {
    id: "server-config-endpoint",
    date: "2026-10-14",
    edition: "community",
    title: { en: "Server capabilities endpoint", zh: "服务器能力接口" },
    summary: {
      en: "Clients can ask a server what it supports before anyone signs in.",
      zh: "客户端可以在登录之前查询服务器支持哪些功能。",
    },
    points: [
      { en: "GET /api/config reports the API version, the sign-in methods, whether sign-up and Turnstile are on, and whether the server can send email.", zh: "GET /api/config 返回 API 版本、可用的登录方式、是否开放注册和启用 Turnstile，以及服务器能否发送邮件。" },
      { en: "The existing /api/auth-providers answer is unchanged.", zh: "原有的 /api/auth-providers 返回内容保持不变。" },
    ],
  },
  {
    id: "api-keys-table-layout",
    date: "2026-10-14",
    edition: "community",
    title: { en: "API keys table layout fixed", zh: "修复 API 密钥列表布局" },
    summary: {
      en: "The Revoke button on the API keys page no longer wraps onto a second line.",
      zh: "API 密钥页面的“撤销”按钮不再换到第二行。",
    },
    points: [
      {
        en: "Name, key, projects and created time line up in one row, on desktop and on phones.",
        zh: "名称、密钥、项目和创建时间在桌面和手机上都排成一行。",
      },
    ],
  },
  {
    id: "language-follows-your-choice",
    date: "2026-10-13",
    edition: "community",
    title: { en: "Language follows your choice", zh: "语言以你的选择为准" },
    summary: {
      en: "The site no longer switches language on its own because of your browser settings.",
      zh: "网站不再根据浏览器设置自行切换语言。",
    },
    points: [
      {
        en: "A first visit to an English page stays in English; the language you pick, or the language page you open, is remembered for next time.",
        zh: "首次访问英文页面时保持英文；你选择的语言，或你打开的语言版页面，会被记住并用于下次访问。",
      },
    ],
  },
  {
    id: "hide-status-page-branding",
    date: "2026-10-12",
    edition: "community",
    title: { en: "Hide OpenUptime branding", zh: "隐藏 OpenUptime 品牌标识" },
    summary: {
      en: "A status page can now drop the OpenUptime mark and “Powered by” line and show your own logo instead.",
      zh: "状态页现在可以去掉 OpenUptime 标志和“技术支持”字样，改为显示你自己的 Logo。",
    },
    points: [
      {
        en: "Turn on “Hide OpenUptime branding” in the Branding card of a status page.",
        zh: "在状态页的“品牌”卡片里打开“隐藏 OpenUptime 品牌标识”。",
      },
      {
        en: "If the page has a website link, its header shows that website’s logo, fetched from favicon.im; without a link it shows the title only.",
        zh: "页面设置了网站链接时，页眉显示该网站的 Logo（取自 favicon.im）；没有链接则只显示标题。",
      },
      {
        en: "Confirmation and incident emails to subscribers then go out under the page title instead of OpenUptime.",
        zh: "订阅者收到的确认邮件和事件通知邮件，也会以状态页标题而不是 OpenUptime 的名义发出。",
      },
      {
        en: "The option is also available through the API and MCP as hideBranding.",
        zh: "该选项也可通过 API 和 MCP 的 hideBranding 字段设置。",
      },
    ],
    cloud: {
      en: "On the hosted service this is included in the Team plan only. If a workspace moves to another plan, its pages show OpenUptime branding again and your setting is kept.",
      zh: "托管服务中仅 Team 套餐包含此功能。工作区降级后，页面会重新显示 OpenUptime 品牌标识，你的设置会保留。",
    },
    link: { href: "/docs/api", label: { en: "Read the API docs", zh: "阅读 API 文档" } },
  },
  {
    id: "install-as-app",
    date: "2026-10-12",
    edition: "community",
    title: { en: "Install the back office as an app", zh: "把后台安装为应用" },
    summary: {
      en: "OpenUptime can be installed from the browser, and an open tab tells you when a new version is ready.",
      zh: "可以从浏览器把 OpenUptime 安装成应用；有新版本时，已打开的页面会提示你刷新。",
    },
    points: [
      {
        en: "Use “Install” in your browser to get OpenUptime in its own window, with an icon on your desktop or home screen.",
        zh: "在浏览器中选择「安装」，即可在独立窗口中使用 OpenUptime，并在桌面或主屏幕上留下图标。",
      },
      {
        en: "An open tab checks for a new version every 6 hours and offers a Refresh button when there is one.",
        zh: "已打开的页面每 6 小时检查一次新版本，有更新时会提示并提供「刷新」按钮。",
      },
      {
        en: "The app's own files are downloaded in the background when a new version is found, so refreshing is quick and the app shell still opens without a network.",
        zh: "发现新版本时，应用自身的文件会在后台提前下载，刷新后很快就能打开；没有网络时应用外壳也能打开。",
      },
      {
        en: "Nothing from the API is stored on your device: monitor data and sessions always come from the server.",
        zh: "API 数据不会缓存在设备上：监控数据和登录状态始终来自服务器。",
      },
    ],
  },
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
