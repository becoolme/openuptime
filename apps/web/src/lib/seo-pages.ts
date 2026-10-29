import type { L } from "./changelog";

/**
 * Content of the comparison pages (/alternatives/<tool>) and the use-case pages (/for/<segment>).
 *
 * Every statement about OpenUptime here is checked against the code and docs; see OPENUPTIME_ROWS and the notes beside
 * each row. Statements about other products are kept qualitative on purpose: no prices, quotas or counts, because those
 * change. Where a number matters the page says to check the vendor's current pricing.
 */

export interface Faq {
  q: L;
  a: L;
}

export interface Row {
  topic: L;
  ou: L;
  them: L;
}

export interface Tool {
  slug: string;
  name: string;
  /** <title> without the site suffix, at most 60 characters with " · OpenUptime" appended */
  title: L;
  description: L;
  lede: L;
  /** what the product is, in neutral words */
  about: L;
  rows: Row[];
  /** things the other product is known for that OpenUptime does not do */
  theyHave: L[];
  bestThem: L[];
  bestUs: L[];
  migrate: L[];
  faq: Faq[];
}

const l = (en: string, zh: string): L => ({ en, zh });

/** Facts about OpenUptime shared by every comparison table. Sources: README, docs/reference.md, docs pages, apps/api. */
export const OU = {
  license: l("MIT license, source on GitHub", "MIT 许可证，源码在 GitHub"),
  hosting: l(
    "Hosted service, or self-host with Docker and Postgres, or on Cloudflare Workers with Postgres",
    "托管服务；也可用 Docker 加 Postgres 自托管，或部署到 Cloudflare Workers 加 Postgres",
  ),
  selfHost: l("Yes, the same code as the hosted service, no feature limits", "支持，与托管服务是同一份代码，没有功能限制"),
  types: l(
    "HTTP and HTTPS (expected status, keyword must or must not appear, custom headers), TCP, DNS, heartbeat, PostgreSQL, MySQL / MariaDB and Redis reachability",
    "HTTP / HTTPS（预期状态码、关键字必须出现或不得出现、自定义请求头）、TCP、DNS、心跳、PostgreSQL、MySQL / MariaDB 与 Redis 连通性",
  ),
  regions: l(
    "HTTP, TCP and WebSocket monitors can be checked from several regions; a run fails when most answering regions fail. Self-hosters run their own probes",
    "HTTP、TCP 与 WebSocket 监控可从多个区域检测，多数应答区域失败才判定失败。自托管时由你自己运行探针",
  ),
  status: l(
    "Public status pages with grouped components, incident history, email subscriptions, an RSS feed and an embeddable badge",
    "公开状态页，支持分组、事件历史、邮件订阅、RSS 与可嵌入的状态徽章",
  ),
  alerts: l(
    "Email, Slack, Discord, Lark / Feishu, Telegram, PagerDuty and webhooks; per-monitor routing, repeat reminders, escalation until acknowledged; iOS push",
    "邮件、Slack、Discord、飞书 / Lark、Telegram、PagerDuty 与 Webhook；按监控项路由、重复提醒、未确认时逐级升级；iOS 推送",
  ),
  automation: l(
    "REST API, JSON import and export of monitors, and an MCP server for AI agents (OAuth)",
    "REST API、监控项 JSON 导入导出，以及支持 OAuth 的 MCP 服务（供 AI Agent 使用）",
  ),
  team: l("Workspaces, projects and roles with invitations", "工作区、项目与角色，支持邀请成员"),
} as const;

/** What OpenUptime cannot do today. Every item was checked: there is no code path for it. */
export const OU_GAPS: L[] = [
  l("No TLS certificate expiry monitoring.", "不监控 TLS 证书到期。"),
  l("No ICMP ping monitor; use a TCP or HTTP check instead.", "没有 ICMP ping 监控；可改用 TCP 或 HTTP 检测。"),
  l("No browser-based or multi-step transaction checks, and no real user monitoring.", "没有基于浏览器或多步骤的事务检测，也没有真实用户监控。"),
  l("No SMS or phone-call alerts and no on-call rotation schedules. Escalation works by channel and by minutes unacknowledged.", "没有短信或电话告警，也没有值班排班表。升级按告警渠道和未确认的分钟数进行。"),
  l("Database monitors check that the server answers; they send no credentials and run no queries.", "数据库监控只检查服务端是否应答，不发送凭据，也不执行查询。"),
];

const importStep = l(
  "Open Monitors in OpenUptime and upload the JSON file with the import button, or send it to POST /api/monitors/import. Up to 500 monitors per file. Entries that cannot be imported are listed with the reason and the rest are created.",
  "在 OpenUptime 的监控页用导入按钮上传 JSON 文件，或发送到 POST /api/monitors/import。每个文件最多 500 个监控项。无法导入的条目会连同原因一并列出，其余照常创建。",
);
const fieldsStep = l(
  "The importer reads name (or friendly_name), target (or url, hostname, host), interval in seconds, and type (http, https, keyword, tcp, port, dns, heartbeat, postgres, mysql, redis). Intervals below 60 seconds are raised to 60.",
  "导入时会识别 name（或 friendly_name）、target（或 url、hostname、host）、以秒为单位的 interval，以及 type（http、https、keyword、tcp、port、dns、heartbeat、postgres、mysql、redis）。小于 60 秒的间隔会提升到 60 秒。",
);
const channelsStep = l(
  "Alert channels, status pages and incident history are not imported. Add your channels under Alerting, then create a status page and pick the monitors for it.",
  "告警渠道、状态页和事件历史不会被导入。请在告警页添加渠道，再创建状态页并选择要展示的监控项。",
);
const parallelStep = l(
  "Run both tools side by side for a few days before you switch alerts off in the old one, and compare the incidents each one opens.",
  "先让两个工具并行运行几天，再关闭旧工具的告警，并对比两边各自创建的事件。",
);

const faqSelfHost = (name: string): Faq => ({
  q: l(`Can I self-host OpenUptime instead of using ${name}?`, `可以用自托管的 OpenUptime 代替 ${name} 吗？`),
  a: l(
    "Yes. OpenUptime runs from one Docker image with Postgres, or on Cloudflare Workers with a Postgres database you provide. The self-hosted version is the same code as the hosted service.",
    "可以。OpenUptime 可用一个 Docker 镜像加 Postgres 运行，也可部署在 Cloudflare Workers 上并使用你自己提供的 Postgres 数据库。自托管版本与托管服务是同一份代码。",
  ),
});
const faqImport = (name: string): Faq => ({
  q: l(`How do I move my ${name} monitors to OpenUptime?`, `如何把 ${name} 的监控项迁移到 OpenUptime？`),
  a: l(
    "Put your monitors in a JSON list and import it on the Monitors page or through the API. The importer accepts common field names used by other tools, skips entries it cannot read and reports why. Channels and status pages are set up again by hand.",
    "把监控项整理成 JSON 列表，在监控页或通过 API 导入。导入器接受其他工具常见的字段名，读不懂的条目会被跳过并说明原因。告警渠道和状态页需要手动重新设置。",
  ),
});
const faqGaps = (name: string): Faq => ({
  q: l(`What does ${name} do that OpenUptime does not?`, `${name} 有哪些 OpenUptime 没有的功能？`),
  a: l(
    "OpenUptime has no TLS certificate expiry monitoring, no ICMP ping monitor, no browser or multi-step checks, and no SMS, phone-call or on-call schedule features. If you rely on one of those, check whether the other tool covers it before you switch.",
    "OpenUptime 没有 TLS 证书到期监控、ICMP ping 监控、浏览器或多步骤检测，也没有短信、电话告警或值班排班功能。如果你依赖其中之一，切换前请先确认。",
  ),
});
const faqPricing = (name: string): Faq => ({
  q: l(`Is OpenUptime cheaper than ${name}?`, `OpenUptime 比 ${name} 便宜吗？`),
  a: l(
    `Self-hosting costs only the infrastructure you run it on. The hosted service has plans, and ${name} changes its own pricing from time to time, so compare the current pricing pages of both for the number of monitors and check interval you need.`,
    `自托管只需承担运行它的基础设施成本。托管服务有各档套餐，${name} 的价格也会不时调整，请对照两边当前的价格页，按你需要的监控数量和检测间隔来比较。`,
  ),
});

export const TOOLS: Tool[] = [
  {
    slug: "uptimerobot",
    name: "UptimeRobot",
    title: l("UptimeRobot alternative", "UptimeRobot 替代方案"),
    description: l(
      "OpenUptime vs UptimeRobot: monitor types, status pages, alerting, API and self-hosting compared, with an honest list of gaps.",
      "OpenUptime 与 UptimeRobot 对比：监控类型、状态页、告警、API 与自托管，并如实列出差距。",
    ),
    lede: l(
      "UptimeRobot is a hosted service known for quick setup of website, keyword and port checks. OpenUptime covers the same basics, adds multi-region checks and an MCP server, and can be self-hosted.",
      "UptimeRobot 是托管服务，以快速设置网站、关键字和端口检测见长。OpenUptime 覆盖同样的基础功能，另有多区域检测和 MCP 服务，并且可以自托管。",
    ),
    about: l(
      "UptimeRobot is a closed-source, hosted monitoring service with a free tier and paid plans. It is not available as software you run yourself.",
      "UptimeRobot 是闭源的托管监控服务，有免费档和付费套餐，不提供可自行部署的软件。",
    ),
    rows: [
      { topic: l("License", "许可证"), ou: OU.license, them: l("Closed source", "闭源") },
      { topic: l("Where it runs", "运行方式"), ou: OU.hosting, them: l("Hosted by the vendor only", "仅由厂商托管") },
      { topic: l("Self-hosting", "自托管"), ou: OU.selfHost, them: l("Not offered", "不提供") },
      { topic: l("Monitor types", "监控类型"), ou: OU.types, them: l("Website, keyword and port style checks; see their site for the full list", "网站、关键字、端口等检测；完整列表见其官网") },
      { topic: l("Status pages", "状态页"), ou: OU.status, them: l("Offered; check their docs for features per plan", "提供；各套餐的功能请查看其文档") },
      { topic: l("Pricing", "价格"), ou: l("Free to self-host. The hosted service has plans; check the current ones", "自托管免费。托管服务有各档套餐，请查看最新方案"), them: l("Free tier and paid plans; check their current pricing", "有免费档与付费套餐；请查看其最新价格") },
    ],
    theyHave: [
      l("A long-running hosted service you do not have to operate. With OpenUptime you either use the hosted service or run it yourself.", "无需自行运维的长期托管服务。使用 OpenUptime 时，你要么用托管服务，要么自己运行。"),
    ],
    bestThem: [
      l("You want a hosted service and the checks you need are plain website, keyword or port checks.", "你想用托管服务，而且需要的只是网站、关键字或端口这类基础检测。"),
      l("You do not want to read any documentation before the first monitor is running.", "你希望不看任何文档就能让第一个监控跑起来。"),
    ],
    bestUs: [
      l("You want to see the source, or run monitoring on your own infrastructure.", "你想看到源码，或把监控运行在自己的基础设施上。"),
      l("You want one monitor checked from several regions before it counts as down.", "你希望同一个监控项从多个区域检测后才判定为故障。"),
      l("You want to manage monitors from scripts or from an AI agent over MCP.", "你想通过脚本或经 MCP 的 AI Agent 管理监控项。"),
    ],
    migrate: [
      l("Export or copy your monitors from UptimeRobot into a JSON list: for each one a name, a url or hostname, the interval in seconds, and the type.", "把 UptimeRobot 中的监控项导出或整理成 JSON 列表：每项包含名称、url 或 hostname、以秒为单位的间隔和类型。"),
      fieldsStep,
      importStep,
      channelsStep,
      parallelStep,
    ],
    faq: [faqImport("UptimeRobot"), faqSelfHost("UptimeRobot"), faqGaps("UptimeRobot"), faqPricing("UptimeRobot")],
  },
  {
    slug: "better-stack",
    name: "Better Stack",
    title: l("Better Stack (Better Uptime) alternative", "Better Stack（Better Uptime）替代方案"),
    description: l(
      "OpenUptime vs Better Stack (Better Uptime): where an open-source uptime tool fits and where on-call and logs matter more.",
      "OpenUptime 与 Better Stack（Better Uptime）对比：开源可用性监控适合哪些场景，什么时候值班和日志更重要。",
    ),
    lede: l(
      "Better Stack bundles uptime monitoring with incident management, on-call scheduling and log management in one hosted product. OpenUptime is narrower: monitoring, incidents, alerts and status pages, open source and self-hostable.",
      "Better Stack 把可用性监控、事件管理、值班排班和日志管理放在同一个托管产品里。OpenUptime 更专注：监控、事件、告警和状态页，开源且可自托管。",
    ),
    about: l(
      "Better Stack (which includes the product formerly called Better Uptime) is a closed-source, hosted platform. Uptime monitoring is one part of it, next to on-call and incident management and log management.",
      "Better Stack（包含原名 Better Uptime 的产品）是闭源的托管平台。可用性监控只是其中一部分，此外还有值班与事件管理以及日志管理。",
    ),
    rows: [
      { topic: l("License", "许可证"), ou: OU.license, them: l("Closed source", "闭源") },
      { topic: l("Where it runs", "运行方式"), ou: OU.hosting, them: l("Hosted by the vendor only", "仅由厂商托管") },
      { topic: l("Scope", "产品范围"), ou: l("Uptime monitoring, incidents, alerts and status pages", "可用性监控、事件、告警与状态页"), them: l("Uptime monitoring plus on-call, incident management and logs", "可用性监控，加上值班、事件管理与日志") },
      { topic: l("Alerting", "告警"), ou: OU.alerts, them: l("On-call scheduling and phone or SMS alerts are part of the product; check their docs for what each plan includes", "值班排班以及电话、短信告警是产品的一部分；各套餐包含的内容请查看其文档") },
      { topic: l("Automation", "自动化"), ou: OU.automation, them: l("Has an API; check their docs for coverage", "提供 API；覆盖范围请查看其文档") },
      { topic: l("Pricing", "价格"), ou: l("Free to self-host. The hosted service has plans; check the current ones", "自托管免费。托管服务有各档套餐，请查看最新方案"), them: l("Check their current pricing", "请查看其最新价格") },
    ],
    theyHave: [
      l("On-call schedules and phone-call or SMS alerts. OpenUptime escalates by channel after a number of minutes unacknowledged, but has no rota.", "值班排班表以及电话、短信告警。OpenUptime 在事件未确认若干分钟后按渠道升级，但没有排班表。"),
      l("Log management next to monitoring. OpenUptime does not collect logs.", "监控之外还有日志管理。OpenUptime 不收集日志。"),
    ],
    bestThem: [
      l("Your team needs on-call rotations and phone calls for pages, in the same tool as monitoring.", "你的团队需要值班轮换和电话告警，并希望与监控放在同一个工具里。"),
      l("You also want logs and incident management from one vendor.", "你还想从同一家厂商获得日志和事件管理。"),
    ],
    bestUs: [
      l("You only need monitoring, incidents and a status page, and want to pay for nothing else.", "你只需要监控、事件和状态页，不想为其他功能付费。"),
      l("You want to run it yourself, or read and change the code.", "你想自己运行，或阅读、修改代码。"),
      l("Slack, Telegram, PagerDuty or webhooks already cover how your team gets paged.", "你们已经通过 Slack、Telegram、PagerDuty 或 Webhook 来接收告警。"),
    ],
    migrate: [
      l("List your monitors as JSON with a name, a url or hostname, the interval in seconds and the type. If you have many, the Better Stack API can help you produce that list.", "把监控项整理成 JSON，每项包含名称、url 或 hostname、以秒为单位的间隔和类型。数量较多时，可借助 Better Stack 的 API 生成这份列表。"),
      fieldsStep,
      importStep,
      l("If PagerDuty is how your team is paged today, add it as a channel in OpenUptime with the same routing key. Otherwise recreate Slack, Telegram, email or webhook channels under Alerting.", "如果你们目前通过 PagerDuty 接收告警，可在 OpenUptime 里用同一个路由密钥添加该渠道；否则请在告警页重新创建 Slack、Telegram、邮件或 Webhook 渠道。"),
      parallelStep,
    ],
    faq: [
      faqImport("Better Stack"),
      faqGaps("Better Stack"),
      {
        q: l("Does OpenUptime have on-call scheduling?", "OpenUptime 有值班排班吗？"),
        a: l(
          "No. You can repeat reminders and escalate to other channels when an incident stays unacknowledged, and acknowledge it from the iOS app, but there is no rota or phone-call paging. PagerDuty works as a channel if you already use it for that.",
          "没有。你可以设置重复提醒，并在事件长时间未确认时升级到其他渠道，也可以在 iOS 应用里确认事件，但没有排班表和电话告警。如果你已在用 PagerDuty，可以把它作为一个告警渠道。",
        ),
      },
      faqPricing("Better Stack"),
    ],
  },
  {
    slug: "pingdom",
    name: "Pingdom",
    title: l("Pingdom alternative", "Pingdom 替代方案"),
    description: l(
      "OpenUptime vs Pingdom: uptime checks, status pages and alerting compared, and where transaction checks and real user monitoring matter.",
      "OpenUptime 与 Pingdom 对比：可用性检测、状态页与告警，以及事务检测和真实用户监控的取舍。",
    ),
    lede: l(
      "Pingdom is an established hosted service for website monitoring, with transaction checks and real user monitoring. OpenUptime covers uptime, incidents and status pages, with the source open and a self-hosted option.",
      "Pingdom 是老牌托管的网站监控服务，提供事务检测和真实用户监控。OpenUptime 覆盖可用性、事件和状态页，源码公开，并可自托管。",
    ),
    about: l(
      "Pingdom is a closed-source, hosted product from SolarWinds. Besides uptime checks it offers synthetic transaction monitoring, real user monitoring and page speed measurements.",
      "Pingdom 是 SolarWinds 旗下的闭源托管产品。除可用性检测外，还提供合成事务监控、真实用户监控和页面速度测量。",
    ),
    rows: [
      { topic: l("License", "许可证"), ou: OU.license, them: l("Closed source", "闭源") },
      { topic: l("Where it runs", "运行方式"), ou: OU.hosting, them: l("Hosted by the vendor only", "仅由厂商托管") },
      { topic: l("Uptime checks", "可用性检测"), ou: OU.types, them: l("Website and server uptime checks from the vendor's locations", "从厂商的检测节点对网站和服务器做可用性检测") },
      { topic: l("Transaction checks and real user monitoring", "事务检测与真实用户监控"), ou: l("Not available", "不提供"), them: l("Offered as separate products", "作为独立产品提供") },
      { topic: l("Status pages", "状态页"), ou: OU.status, them: l("Offered; check their docs for details", "提供；详情请查看其文档") },
      { topic: l("Pricing", "价格"), ou: l("Free to self-host. The hosted service has plans; check the current ones", "自托管免费。托管服务有各档套餐，请查看最新方案"), them: l("Check their current pricing", "请查看其最新价格") },
    ],
    theyHave: [
      l("Scripted, multi-step transaction checks and real user monitoring. OpenUptime checks one request at a time.", "脚本化的多步骤事务检测和真实用户监控。OpenUptime 每次只检测一个请求。"),
      l("Page speed measurement. OpenUptime records response time of each check but does not analyse page loads.", "页面速度测量。OpenUptime 会记录每次检测的响应时间，但不分析页面加载过程。"),
    ],
    bestThem: [
      l("You need to test a sign-in or checkout flow step by step, or measure what real visitors experience.", "你需要逐步测试登录或结账流程，或衡量真实访客的体验。"),
      l("You already run other SolarWinds tools and want one vendor.", "你已经在用 SolarWinds 的其他工具，希望统一厂商。"),
    ],
    bestUs: [
      l("A request that returns the right status and the right keyword is all you need to know about.", "你只需要知道请求是否返回了正确的状态码和关键字。"),
      l("You want an open-source tool, a self-hosted copy, or monitors managed by API or MCP.", "你想要开源工具、自托管的副本，或通过 API 或 MCP 管理监控项。"),
      l("You also want to watch TCP ports, DNS, cron heartbeats and database reachability in the same place.", "你还想在同一处监控 TCP 端口、DNS、定时任务心跳和数据库连通性。"),
    ],
    migrate: [
      l("Write your uptime checks as a JSON list with a name, a url or hostname, the interval in seconds and the type. Transaction checks have no equivalent and are not part of the list.", "把可用性检测整理成 JSON 列表，每项包含名称、url 或 hostname、以秒为单位的间隔和类型。事务检测没有对应功能，不在列表范围内。"),
      fieldsStep,
      importStep,
      channelsStep,
      parallelStep,
    ],
    faq: [
      faqImport("Pingdom"),
      faqGaps("Pingdom"),
      {
        q: l("Can OpenUptime replace Pingdom transaction checks?", "OpenUptime 能替代 Pingdom 的事务检测吗？"),
        a: l(
          "Not directly. OpenUptime checks single requests: status code, a keyword that must or must not appear, and custom headers. You can point separate monitors at the key steps of a flow, but it cannot click through a page.",
          "不能直接替代。OpenUptime 检测的是单个请求：状态码、必须或不得出现的关键字，以及自定义请求头。你可以为流程中的关键步骤分别建立监控项，但它无法模拟页面点击。",
        ),
      },
      faqPricing("Pingdom"),
    ],
  },
  {
    slug: "statuscake",
    name: "StatusCake",
    title: l("StatusCake alternative", "StatusCake 替代方案"),
    description: l(
      "OpenUptime vs StatusCake: uptime checks, status pages, alerting and self-hosting compared, including what OpenUptime leaves out.",
      "OpenUptime 与 StatusCake 对比：可用性检测、状态页、告警与自托管，并说明 OpenUptime 没有的功能。",
    ),
    lede: l(
      "StatusCake is a hosted service that groups uptime checks with page speed, SSL and domain monitoring. OpenUptime focuses on uptime, incidents and status pages, and is open source.",
      "StatusCake 是托管服务，把可用性检测与页面速度、SSL 和域名监控放在一起。OpenUptime 专注于可用性、事件和状态页，并且开源。",
    ),
    about: l(
      "StatusCake is a closed-source, hosted monitoring service with a free tier and paid plans. Besides uptime checks it offers page speed, SSL and domain monitoring.",
      "StatusCake 是闭源的托管监控服务，有免费档和付费套餐。除可用性检测外，还提供页面速度、SSL 与域名监控。",
    ),
    rows: [
      { topic: l("License", "许可证"), ou: OU.license, them: l("Closed source", "闭源") },
      { topic: l("Where it runs", "运行方式"), ou: OU.hosting, them: l("Hosted by the vendor only", "仅由厂商托管") },
      { topic: l("Uptime checks", "可用性检测"), ou: OU.types, them: l("Website and server uptime checks; see their site for the full list", "网站与服务器可用性检测；完整列表见其官网") },
      { topic: l("SSL and domain monitoring", "SSL 与域名监控"), ou: l("Not available. OpenUptime does not watch certificate or domain expiry", "不提供。OpenUptime 不监控证书或域名到期"), them: l("Offered", "提供") },
      { topic: l("Status pages", "状态页"), ou: OU.status, them: l("Offered; check their docs for details", "提供；详情请查看其文档") },
      { topic: l("Pricing", "价格"), ou: l("Free to self-host. The hosted service has plans; check the current ones", "自托管免费。托管服务有各档套餐，请查看最新方案"), them: l("Free tier and paid plans; check their current pricing", "有免费档与付费套餐；请查看其最新价格") },
    ],
    theyHave: [
      l("SSL certificate and domain expiry monitoring. OpenUptime has neither.", "SSL 证书和域名到期监控。OpenUptime 两者都没有。"),
      l("Page speed testing. OpenUptime records response time only.", "页面速度测试。OpenUptime 只记录响应时间。"),
    ],
    bestThem: [
      l("You want certificate and domain expiry warnings from the same tool that checks uptime.", "你希望在检测可用性的同一个工具里收到证书和域名到期提醒。"),
      l("You want a hosted service with a free tier to start with.", "你想先从有免费档的托管服务开始。"),
    ],
    bestUs: [
      l("You want open-source monitoring you can read, change or run yourself.", "你想要可阅读、可修改、可自行运行的开源监控。"),
      l("You need checks from several regions to agree before an incident opens.", "你需要多个区域的检测结果一致后才创建事件。"),
      l("You want incident updates that go to email and RSS subscribers of a status page.", "你希望事件更新能发送给状态页的邮件和 RSS 订阅者。"),
    ],
    migrate: [
      l("List your uptime tests as JSON with a name, a url or hostname, the interval in seconds and the type.", "把可用性测试整理成 JSON，每项包含名称、url 或 hostname、以秒为单位的间隔和类型。"),
      fieldsStep,
      importStep,
      l("Keep a separate reminder for certificate and domain renewals, since OpenUptime will not warn you about them.", "请另外设置证书和域名续期的提醒，OpenUptime 不会就此预警。"),
      parallelStep,
    ],
    faq: [
      faqImport("StatusCake"),
      faqGaps("StatusCake"),
      {
        q: l("Does OpenUptime warn me before an SSL certificate expires?", "OpenUptime 会在 SSL 证书到期前提醒我吗？"),
        a: l(
          "No. An HTTPS monitor fails once the certificate is rejected, but there is no advance warning. Track renewals with your certificate provider or another tool.",
          "不会。证书被拒绝后，HTTPS 监控才会失败，但没有提前预警。请通过证书提供方或其他工具跟踪续期。",
        ),
      },
      faqPricing("StatusCake"),
    ],
  },
  {
    slug: "uptime-kuma",
    name: "Uptime Kuma",
    title: l("Uptime Kuma alternative", "Uptime Kuma 替代方案"),
    description: l(
      "OpenUptime vs Uptime Kuma: two open-source, self-hostable uptime tools compared, with multi-region probes, a hosted option and an API.",
      "OpenUptime 与 Uptime Kuma 对比：两个开源、可自托管的可用性监控工具，涉及多区域探针、托管选项与 API。",
    ),
    lede: l(
      "Uptime Kuma is a popular open-source tool you run yourself. OpenUptime is also open source and self-hostable, and differs in multi-region probes, workspaces with roles, an MCP server and an optional hosted service.",
      "Uptime Kuma 是广受欢迎、需自行运行的开源工具。OpenUptime 同样开源、可自托管，区别在于多区域探针、带角色的工作区、MCP 服务以及可选的托管服务。",
    ),
    about: l(
      "Uptime Kuma is an open-source (MIT) monitoring tool that you install and operate yourself. It is known for an easy install and a wide range of monitor types and notification options.",
      "Uptime Kuma 是开源（MIT）的监控工具，需要你自己安装和运维，以安装简单、监控类型和通知方式丰富著称。",
    ),
    rows: [
      { topic: l("License", "许可证"), ou: OU.license, them: l("MIT license, source on GitHub", "MIT 许可证，源码在 GitHub") },
      { topic: l("Where it runs", "运行方式"), ou: OU.hosting, them: l("Self-hosted; the project does not run a hosted service", "自托管；项目本身不提供托管服务") },
      { topic: l("Checks from several regions", "多区域检测"), ou: OU.regions, them: l("Checks run from the machine where it is installed; for another location you run another instance", "检测在安装它的机器上运行；要换一个位置，需要另外再部署一个实例") },
      { topic: l("Monitor types", "监控类型"), ou: OU.types, them: l("A wide range, including ping and certificate expiry; see its docs for the current list", "类型丰富，包括 ping 与证书到期；当前列表见其文档") },
      { topic: l("Alerts", "告警"), ou: OU.alerts, them: l("Many notification integrations; see its docs for the list", "提供大量通知集成；列表见其文档") },
      { topic: l("Teams and automation", "团队与自动化"), ou: l(`${OU.team.en}; ${OU.automation.en}`, `${OU.team.zh}；${OU.automation.zh}`), them: l("Check its docs for user management and API coverage", "用户管理与 API 覆盖范围请查看其文档") },
    ],
    theyHave: [
      l("More monitor types, among them ping and TLS certificate expiry, which OpenUptime lacks.", "更多监控类型，包括 ping 和 TLS 证书到期，这些 OpenUptime 都没有。"),
      l("A large community and a long history as a self-hosted tool.", "庞大的社区和作为自托管工具的长期积累。"),
    ],
    bestThem: [
      l("You want a single self-hosted instance with the broadest set of monitor types and notification options.", "你想要一个自托管实例，监控类型和通知方式越全越好。"),
      l("You need ping or certificate expiry monitoring.", "你需要 ping 或证书到期监控。"),
    ],
    bestUs: [
      l("You want the same monitor checked from several places, using probes you run in the regions you care about.", "你想让同一个监控项从多个地点检测，探针由你部署在关心的区域。"),
      l("You want the option of a hosted service now and self-hosting later, or the reverse, on the same code.", "你希望现在用托管服务、以后改为自托管（或反过来），并且代码是同一份。"),
      l("Several people or clients share one installation, and you want workspaces, projects and roles.", "多人或多个客户共用同一套部署，需要工作区、项目和角色。"),
      l("You want to drive monitoring from scripts or an AI agent.", "你想通过脚本或 AI Agent 驱动监控。"),
    ],
    migrate: [
      l("Write your Kuma monitors as a JSON list with a name, a url or hostname, the interval in seconds and the type. OpenUptime does not read Kuma's backup file directly.", "把 Kuma 的监控项整理成 JSON 列表，每项包含名称、url 或 hostname、以秒为单位的间隔和类型。OpenUptime 不能直接读取 Kuma 的备份文件。"),
      fieldsStep,
      importStep,
      l("Ping, certificate expiry and other types OpenUptime does not have are skipped with a reason; replace ping with a TCP or HTTP check where that makes sense.", "OpenUptime 不支持的 ping、证书到期等类型会连同原因被跳过；合适时可用 TCP 或 HTTP 检测代替 ping。"),
      l("Monitors that point at private addresses are refused unless you set ALLOW_PRIVATE_TARGETS=true on your instance. Read the self-host docs before turning that on.", "指向内网地址的监控项会被拒绝，除非你在自己的实例上设置 ALLOW_PRIVATE_TARGETS=true。开启前请先阅读自托管文档。"),
      channelsStep,
    ],
    faq: [
      {
        q: l("Is OpenUptime a drop-in replacement for Uptime Kuma?", "OpenUptime 能直接替换 Uptime Kuma 吗？"),
        a: l(
          "For HTTP, TCP, DNS, heartbeat and database reachability checks, largely yes. It has no ping or certificate expiry monitor, and Kuma's backup file cannot be imported directly, so plan for a small conversion step.",
          "对于 HTTP、TCP、DNS、心跳和数据库连通性检测，基本可以。它没有 ping 和证书到期监控，也不能直接导入 Kuma 的备份文件，需要做一步简单的格式转换。",
        ),
      },
      faqImport("Uptime Kuma"),
      {
        q: l("What does self-hosting OpenUptime need compared with Uptime Kuma?", "和 Uptime Kuma 相比，自托管 OpenUptime 需要什么？"),
        a: l(
          "A Postgres database next to the app. The Docker setup starts both with one compose file. Uptime Kuma's own storage requirements are in its documentation.",
          "应用旁边需要一个 Postgres 数据库。Docker 方案用一个 compose 文件同时启动两者。Uptime Kuma 自身的存储要求请参阅其文档。",
        ),
      },
      faqGaps("Uptime Kuma"),
    ],
  },
];

export interface Scenario {
  title: L;
  body: L;
  /** feature names shown as tags */
  uses: string[];
}

export interface Segment {
  slug: string;
  title: L;
  description: L;
  name: L;
  lede: L;
  scenarios: Scenario[];
  statusPage: L;
  alerting: L;
  limits: L[];
  faq: Faq[];
}

export const SEGMENTS: Segment[] = [
  {
    slug: "saas",
    name: l("SaaS", "SaaS 产品"),
    title: l("Uptime monitoring for SaaS", "SaaS 产品的可用性监控"),
    description: l(
      "Monitor a SaaS API, background jobs, databases and a public status page with OpenUptime. Open source, self-hostable.",
      "用 OpenUptime 监控 SaaS 的 API、后台任务、数据库，并提供公开状态页。开源，可自托管。",
    ),
    lede: l(
      "A SaaS product fails in more places than its home page. These are the checks that map to a typical stack, and how customers find out about an incident.",
      "SaaS 产品出问题的地方不止首页。下面是与典型技术栈对应的检测方式，以及客户如何得知事件。",
    ),
    scenarios: [
      {
        title: l("The API answers, and answers correctly", "API 不仅有响应，而且响应正确"),
        body: l(
          "Point an HTTP monitor at your health endpoint, set the expected status code, and require a keyword from the response body, such as \"ok\". A 200 from an error page then still counts as down. Add a request header if the endpoint needs a bearer token.",
          "为健康检查接口创建 HTTP 监控，设置预期状态码，并要求响应体包含某个关键字，例如 \"ok\"。这样返回 200 的错误页面也会被判定为故障。如果接口需要 Bearer 令牌，可添加请求头。",
        ),
        uses: ["HTTP", "keyword", "headers"],
      },
      {
        title: l("Background jobs and cron", "后台任务与定时任务"),
        body: l(
          "A heartbeat monitor gives each job a URL to call when it finishes. If no ping arrives within the interval plus a grace period you set, the monitor fails. This catches a job that silently stopped, which no HTTP check can see.",
          "心跳监控会为每个任务生成一个 URL，任务完成时调用它。如果在间隔加上你设置的宽限期内没有收到请求，监控就会失败。这能发现悄悄停止的任务，而 HTTP 检测看不到这一点。",
        ),
        uses: ["heartbeat"],
      },
      {
        title: l("Databases and caches", "数据库与缓存"),
        body: l(
          "PostgreSQL, MySQL / MariaDB and Redis monitors confirm that the server answers its handshake or PING. They send no credentials and run no queries, so they show reachability, not query health. The target must be a public address unless the operator allows private targets on a self-hosted instance.",
          "PostgreSQL、MySQL / MariaDB 与 Redis 监控用于确认服务端能响应握手或 PING。它们不发送凭据、不执行查询，因此反映的是连通性，而不是查询是否健康。目标必须是公网地址，除非自托管实例的运维允许私有目标。",
        ),
        uses: ["PostgreSQL", "MySQL", "Redis"],
      },
      {
        title: l("Customers in more than one part of the world", "客户分布在多个地区"),
        body: l(
          "For HTTP, TCP and WebSocket monitors, pick several regions. The run fails when most of the regions that answered fail, so one bad route does not open an incident, and a probe that is down is left out of the vote. Each region counts as one check. Where the probes are depends on the deployment; see the multi-region docs.",
          "为 HTTP、TCP 和 WebSocket 监控选择多个区域。多数应答区域失败时本次检测才判定失败，因此某一条线路出问题不会创建事件，而自身故障的探针不参与投票。每个区域算一次检测。探针的位置取决于部署方式，详见多区域文档。",
        ),
        uses: [l("multi-region", "多区域").en],
      },
      {
        title: l("Fewer pages for the same outage", "同一次故障，少一些告警"),
        body: l(
          "Make the monitors of services behind your API depend on the API monitor: while it is down they keep recording but open no incident and send no alert. A failure within ten minutes of recovery reopens the previous incident (and sends a short \"down again\" alert) instead of opening a new one.",
          "让 API 背后的各服务监控依赖于 API 监控：它故障期间，这些监控仍会记录状态，但不创建事件也不发送告警。恢复后十分钟内再次失败，会重新打开上一个事件（并发送简短的“再次故障”告警），而不是新建一个。",
        ),
        uses: [l("dependencies", "依赖").en],
      },
    ],
    statusPage: l(
      "Publish a status page with your monitors grouped by component, for example API, Dashboard and Webhooks. Customers can subscribe by email or RSS, and you post updates on an incident as it moves from investigating to resolved. The embeddable badge puts the current state on your own site.",
      "发布状态页，按组件对监控项分组，例如 API、控制台、Webhook。客户可通过邮件或 RSS 订阅，你可以在事件从调查中到已解决的过程中发布更新。可嵌入的徽章能把当前状态显示在你自己的网站上。",
    ),
    alerting: l(
      "Send alerts to Slack for the team and to PagerDuty for whoever is on call, and route each monitor to only the channels that need it. Set repeat reminders and an escalation level that fires when an incident stays unacknowledged.",
      "把告警发到 Slack 通知团队，发到 PagerDuty 通知值班的人，并让每个监控项只路由到需要它的渠道。可设置重复提醒，以及事件长时间未确认时触发的升级。",
    ),
    limits: [
      l("Checks run at most once a minute.", "检测最快每分钟一次。"),
      l("No synthetic browser tests for sign-in or checkout flows.", "不支持针对登录或结账流程的浏览器合成测试。"),
      l("No TLS certificate expiry warning; track renewals separately.", "没有 TLS 证书到期预警，请另行跟踪续期。"),
    ],
    faq: [
      {
        q: l("How do I monitor background jobs with OpenUptime?", "如何用 OpenUptime 监控后台任务？"),
        a: l(
          "Create a heartbeat monitor, copy its URL and call it at the end of each run. If a ping is missing after the interval and grace period, the monitor goes down and alerts.",
          "创建心跳监控，复制它的 URL，并在每次任务结束时调用。如果超过间隔和宽限期仍未收到请求，监控会变为故障并发出告警。",
        ),
      },
      {
        q: l("Can customers subscribe to incident updates?", "客户可以订阅事件更新吗？"),
        a: l(
          "Yes. Each public status page offers email subscriptions with double opt-in and an RSS feed. Subscribers are emailed when an incident opens or resolves on a monitor shown on that page.",
          "可以。每个公开状态页都提供双重确认的邮件订阅和 RSS 订阅。该页面上展示的监控项出现事件或事件解决时，订阅者会收到邮件。",
        ),
      },
      {
        q: l("Can I create monitors from CI or with an AI agent?", "能在 CI 中或通过 AI Agent 创建监控吗？"),
        a: l(
          "Yes. Everything in the app is available through the REST API with an API key, and the MCP server lets agents such as Claude or Cursor create monitors and status pages after you approve access with OAuth.",
          "可以。应用中的功能都可以通过带 API 密钥的 REST API 使用，MCP 服务也允许 Claude、Cursor 等 Agent 在你通过 OAuth 授权后创建监控项和状态页。",
        ),
      },
    ],
  },
  {
    slug: "agencies",
    name: l("Agencies", "代理机构"),
    title: l("Uptime monitoring for agencies", "代理机构的可用性监控"),
    description: l(
      "Monitor many client sites from one OpenUptime account: a workspace per client, separate status pages and alert routing.",
      "用一个 OpenUptime 账号监控多个客户站点：每个客户一个工作区，独立的状态页与告警路由。",
    ),
    lede: l(
      "An agency watches many sites that belong to different people. The useful parts are keeping clients apart, sending the right alert to the right person, and showing clients their own status.",
      "代理机构要照看属于不同客户的许多站点。关键在于把客户区分开，把正确的告警发给正确的人，并让客户看到自己的状态。",
    ),
    scenarios: [
      {
        title: l("One workspace or project per client", "每个客户一个工作区或项目"),
        body: l(
          "Create a workspace for the agency and a project for each client, or a workspace per client if you need to hand it over. Members get roles and are invited by email. API keys and agent grants can be limited to selected projects, so a script for one client touches only that client.",
          "为机构创建一个工作区，再为每个客户建一个项目；如果需要移交，也可以每个客户一个工作区。成员有各自的角色并通过邮件邀请。API 密钥和 Agent 授权可限定在选定的项目内，因此某个客户的脚本只会涉及该客户。",
        ),
        uses: [l("workspaces", "工作区").en, l("projects", "项目").en, l("roles", "角色").en],
      },
      {
        title: l("A standard set of monitors, copied per site", "标准监控集，逐站复制"),
        body: l(
          "Build the monitors you add for every site once: the home page with a keyword check, the login page, DNS and a contact-form endpoint. Export them as JSON and import the file into the next client's project, then change the targets.",
          "把每个站点都要加的监控项建好一次：带关键字检测的首页、登录页、DNS 以及联系表单接口。将它们导出为 JSON，再导入下一个客户的项目，然后改一下目标地址即可。",
        ),
        uses: [l("JSON export", "JSON 导出").en, l("JSON import", "JSON 导入").en],
      },
      {
        title: l("The right alert to the right person", "正确的告警发给正确的人"),
        body: l(
          "Create an email or Slack channel for each client contact or for your own on-duty person, and choose per monitor which channels it notifies. A client can get the alert for their site and nothing else.",
          "为每个客户联系人或你自己的值班人员创建邮件或 Slack 渠道，并按监控项选择通知哪些渠道。客户只会收到自己站点的告警。",
        ),
        uses: [l("per-monitor routing", "按监控项路由").en, "Slack", "email"],
      },
      {
        title: l("Planned work without false alarms", "计划内维护不产生误报"),
        body: l(
          "Schedule a maintenance window before a migration or a launch. Checks continue, but no incidents open and no alerts go out for the monitors it covers.",
          "在迁移或上线前安排维护窗口。检测会继续，但窗口覆盖的监控项不会创建事件，也不会发送告警。",
        ),
        uses: [l("maintenance windows", "维护窗口").en],
      },
    ],
    statusPage: l(
      "Give each client a status page that shows only their monitors, with a title and a light or dark theme. The page can carry a link to the client's own site. Whether the OpenUptime branding can be hidden depends on the hosted plan; a self-hosted instance can always hide it. A client's status page lives under your domain unless you self-host it on theirs.",
      "为每个客户创建只展示其监控项的状态页，可设置标题以及浅色或深色主题，并附上指向客户官网的链接。能否隐藏 OpenUptime 品牌标识取决于托管套餐；自托管实例始终可以隐藏。除非你把它自托管在客户的域名下，否则客户的状态页位于你的域名之下。",
    ),
    alerting: l(
      "Alert channels belong to a project, so each client's channels stay separate from the others. Use email for clients, Slack or Telegram for your own team, and add PagerDuty only for the clients whose sites you carry an on-call duty for.",
      "告警渠道属于项目，因此各客户的渠道互不干扰。客户用邮件，自己的团队用 Slack 或 Telegram，只有你承担值班责任的客户才添加 PagerDuty。",
    ),
    limits: [
      l("Custom domains for status pages are not offered as a setting; a client's status page is served from the OpenUptime address you use.", "状态页的自定义域名目前不是可配置项；客户的状态页使用你所用的 OpenUptime 地址。"),
      l("No built-in client reports or PDF exports.", "没有内置的客户报告或 PDF 导出。"),
      l("Import copies monitors only, not channels or status pages.", "导入只复制监控项，不含告警渠道和状态页。"),
    ],
    faq: [
      {
        q: l("Can one account monitor several clients' sites?", "一个账号能监控多个客户的站点吗？"),
        a: l(
          "Yes. A workspace holds projects, and each project has its own monitors, alert channels and status pages. Members have roles, and you can invite people to the workspace by email.",
          "可以。一个工作区包含多个项目，每个项目有自己的监控项、告警渠道和状态页。成员有各自的角色，你可以通过邮件邀请他们加入工作区。",
        ),
      },
      {
        q: l("How do I set up the same monitors for every new client?", "如何给每个新客户设置同样的监控项？"),
        a: l(
          "Export the monitors of a project as JSON from the Monitors page, then import the file into the new project and edit the targets. Alert channels and status pages are created separately.",
          "在监控页把某个项目的监控项导出为 JSON，再导入新项目并修改目标地址。告警渠道和状态页需要另行创建。",
        ),
      },
      {
        q: l("Can I remove the OpenUptime branding from a client's status page?", "能去掉客户状态页上的 OpenUptime 品牌标识吗？"),
        a: l(
          "Status pages have a hide-branding setting. On the hosted service it depends on the plan; on a self-hosted instance it is always available.",
          "状态页有隐藏品牌标识的设置。在托管服务上取决于套餐；在自托管实例上始终可用。",
        ),
      },
    ],
  },
  {
    slug: "ecommerce",
    name: l("E-commerce", "电商"),
    title: l("Uptime monitoring for e-commerce", "电商站点的可用性监控"),
    description: l(
      "Watch a store's product pages, checkout, DNS and order-sync jobs with OpenUptime, and tell shoppers when something is wrong.",
      "用 OpenUptime 监控店铺的商品页、结账、DNS 和订单同步任务，并在出问题时告知顾客。",
    ),
    lede: l(
      "For a store, a page that loads but cannot sell is as bad as a page that is down. These are the checks that catch that, and the habits that keep alerts useful during a sale.",
      "对店铺来说，页面能打开却无法下单，与页面打不开一样糟糕。下面是能发现这种问题的检测方式，以及在促销期间让告警保持有用的做法。",
    ),
    scenarios: [
      {
        title: l("The page loads and still sells", "页面能打开，也能下单"),
        body: l(
          "Use an HTTP monitor on a product page and require text that only appears when the page is healthy, such as the add-to-cart label. A second monitor can require that an error message does not appear. A shop that returns 200 with an empty catalogue is then reported as down.",
          "对商品页使用 HTTP 监控，并要求页面包含只有正常时才会出现的文字，例如“加入购物车”。再加一个监控，要求错误提示不得出现。这样返回 200 但商品目录为空的店铺也会被判定为故障。",
        ),
        uses: ["HTTP", l("keyword must contain", "关键字必须出现").en, l("keyword must not contain", "关键字不得出现").en],
      },
      {
        title: l("Shoppers in different markets", "不同市场的顾客"),
        body: l(
          "Check the store from the regions where your customers are, so a CDN or routing problem in one market shows up. With several regions the monitor goes down when most of them fail, or you can set how many must fail. The region of each failure is written into the incident.",
          "从顾客所在的区域检测店铺，这样某个市场的 CDN 或线路问题会被发现。选择多个区域后，多数区域失败时监控才判定为故障，你也可以自行设置需要几个区域失败。事件中会写明失败发生在哪些区域。",
        ),
        uses: [l("multi-region", "多区域").en, l("minimum failing regions", "最少失败区域数").en],
      },
      {
        title: l("Slow is the first sign of trouble", "变慢往往是出问题的第一个信号"),
        body: l(
          "Every monitor has a slow-response threshold, 1500 ms by default. Slow checks mark the monitor as degraded, and you can choose to open a minor incident after a number of consecutive slow checks. During a sale this tells you about strain before it becomes an outage.",
          "每个监控项都有响应变慢的阈值，默认 1500 毫秒。检测变慢时监控会标记为降级，你也可以设置连续变慢若干次后创建一个轻微事件。促销期间，这能让你在宕机之前就察觉压力。",
        ),
        uses: [l("slow-response alerts", "响应变慢告警").en],
      },
      {
        title: l("Domain, feeds and order sync", "域名、商品数据源与订单同步"),
        body: l(
          "A DNS monitor confirms that your domain still resolves as expected. Heartbeat monitors cover jobs that run without a page, such as the product feed export or the order sync to your warehouse: the job pings when it finishes, and a missed ping alerts.",
          "DNS 监控用于确认域名仍然按预期解析。心跳监控覆盖没有页面的任务，例如商品数据源导出或同步订单到仓库系统：任务完成时发送请求，漏掉就会告警。",
        ),
        uses: ["DNS", "heartbeat"],
      },
      {
        title: l("Deploys during a sale", "促销期间发布"),
        body: l(
          "Put a maintenance window around planned releases. Checks keep running and are recorded, but no incident opens and no alert fires for the covered monitors.",
          "为计划内的发布设置维护窗口。检测会继续运行并被记录，但窗口覆盖的监控项不会创建事件，也不会触发告警。",
        ),
        uses: [l("maintenance windows", "维护窗口").en],
      },
    ],
    statusPage: l(
      "A public status page lets shoppers and support staff check whether the store is having trouble before they write in. Show the storefront, checkout, and payments callback as separate components. Email and RSS subscribers hear when an incident opens or resolves, and the embeddable badge can sit in your footer or help centre.",
      "公开状态页能让顾客和客服在联系你之前先查看店铺是否出了问题。把店铺前台、结账、支付回调作为不同的组件展示。邮件和 RSS 订阅者会在事件出现或解决时收到通知，可嵌入的徽章也可以放在页脚或帮助中心。",
    ),
    alerting: l(
      "Send checkout failures to the channel that wakes someone, such as PagerDuty or a phone-notified Telegram chat, and slow-response warnings to a quieter Slack channel. Per-monitor routing makes that split possible.",
      "把结账故障发到会叫醒人的渠道，例如 PagerDuty 或会推送到手机的 Telegram 群，把响应变慢的提醒发到较安静的 Slack 频道。按监控项路由使这种区分成为可能。",
    ),
    limits: [
      l("Checks are single requests; OpenUptime cannot walk through a cart and payment flow.", "检测针对单个请求；OpenUptime 无法走完购物车和支付流程。"),
      l("No TLS certificate expiry warning; keep a renewal reminder for your store's certificate.", "没有 TLS 证书到期预警；请为店铺证书另设续期提醒。"),
      l("Checks run at most once a minute.", "检测最快每分钟一次。"),
    ],
    faq: [
      {
        q: l("Can OpenUptime test the checkout flow?", "OpenUptime 能测试结账流程吗？"),
        a: l(
          "Not as a whole flow. It checks one request at a time. You can monitor the cart page, the checkout page and your payment callback endpoint as separate monitors and require the right keyword in each.",
          "不能测试完整流程。它每次检测一个请求。你可以把购物车页、结账页和支付回调接口分别建成监控项，并要求各自包含正确的关键字。",
        ),
      },
      {
        q: l("How do I get warned about a slow store before it goes down?", "如何在店铺宕机之前就收到变慢的警告？"),
        a: l(
          "Set the slow-response threshold on the monitor and choose to open a minor incident after several consecutive slow checks. The monitor shows as degraded in the meantime.",
          "在监控项上设置响应变慢的阈值，并选择连续变慢若干次后创建轻微事件。在此期间监控会显示为降级。",
        ),
      },
      {
        q: l("Does OpenUptime monitor my SSL certificate expiry?", "OpenUptime 会监控 SSL 证书到期吗？"),
        a: l(
          "No. Set a renewal reminder with your certificate provider or use another tool for it. An HTTPS monitor fails once the certificate is rejected.",
          "不会。请在证书提供方处设置续期提醒，或使用其他工具。证书被拒绝后，HTTPS 监控才会失败。",
        ),
      },
    ],
  },
  {
    slug: "devops-teams",
    name: l("DevOps teams", "DevOps 团队"),
    title: l("Uptime monitoring for DevOps teams", "DevOps 团队的可用性监控"),
    description: l(
      "Dependencies between monitors, multi-region verdicts, escalation until acknowledged, API and MCP: OpenUptime for DevOps teams.",
      "监控项依赖、多区域判定、未确认时逐级升级、API 与 MCP：面向 DevOps 团队的 OpenUptime。",
    ),
    lede: l(
      "A monitoring tool for operations should page for real outages, stay quiet for noise, and be scriptable. These are the features that map to that, and what you run yourself when you self-host.",
      "运维团队用的监控工具应当在真正故障时告警、在噪音面前保持安静，并且可以脚本化。下面是与此对应的功能，以及自托管时需要自己运行的部分。",
    ),
    scenarios: [
      {
        title: l("Pages for outages, not for one bad route", "为故障告警，而不是为一条糟糕的线路告警"),
        body: l(
          "Check HTTP, TCP and WebSocket monitors from several regions. The run fails when most answering regions fail, or when the number you set fail. A probe that cannot be reached is left out of the vote instead of counted as a failure, and if no probe answers the check falls back to the default location. The incident names the regions that failed.",
          "让 HTTP、TCP 和 WebSocket 监控从多个区域检测。多数应答区域失败，或达到你设定的失败数量，本次检测才判定失败。无法连接的探针不参与投票，也不算作失败；如果没有任何探针应答，检测会回退到默认位置。事件中会写明哪些区域失败。",
        ),
        uses: [l("multi-region", "多区域").en, "probes"],
      },
      {
        title: l("One root cause, one page", "一个根因，一次告警"),
        body: l(
          "Make dependent monitors point at the monitor they rely on, for example every service behind a gateway. While the parent is down, the children keep recording but open no incident and send no alert. A failure within ten minutes of a resolution reopens the incident and sends a short \"down again\" alert instead of a full new page.",
          "让依赖型监控指向它所依赖的监控项，例如网关背后的每个服务。父监控故障期间，子监控仍会记录，但不创建事件也不发送告警。恢复后十分钟内再次失败，会重新打开该事件并发送简短的“再次故障”告警，而不是新建事件。",
        ),
        uses: [l("dependencies", "依赖").en, l("incident reopening", "事件重新打开").en],
      },
      {
        title: l("An alert that does not get lost", "不会被漏掉的告警"),
        body: l(
          "Send the first alert to Slack and PagerDuty. Set repeat reminders at an interval you choose, and add escalation levels that notify further channels when the incident is still unacknowledged after a number of minutes. Acknowledging the incident, including from the iOS app, stops the repeats.",
          "第一条告警发送到 Slack 和 PagerDuty。可按所选间隔设置重复提醒，并添加升级层级：事件在若干分钟后仍未确认时，通知更多渠道。确认事件（包括在 iOS 应用里确认）即可停止重复。",
        ),
        uses: ["PagerDuty", "Slack", l("reminders", "重复提醒").en, l("escalation", "升级").en],
      },
      {
        title: l("Cron, queues and internal services", "定时任务、队列与内部服务"),
        body: l(
          "Heartbeat monitors cover scheduled jobs. For services on a private network, self-host OpenUptime and set ALLOW_PRIVATE_TARGETS=true; by default monitors that point at private or loopback addresses are refused, which protects a shared instance. Do this only when you trust every account on it.",
          "心跳监控覆盖定时任务。对于私有网络里的服务，请自托管 OpenUptime 并设置 ALLOW_PRIVATE_TARGETS=true；默认情况下，指向私有或回环地址的监控项会被拒绝，以保护共享实例。只有当你信任实例上的所有账号时才这样做。",
        ),
        uses: ["heartbeat", "self-hosting"],
      },
      {
        title: l("Monitoring as code, and agents", "监控即代码，以及 Agent"),
        body: l(
          "Create, change and pause monitors through the REST API with an API key, export a project's monitors as JSON for review or backup, and import them elsewhere. The MCP server gives agents such as Claude or Cursor the same reach after an OAuth approval, limited to the workspaces and projects you choose.",
          "通过带 API 密钥的 REST API 创建、修改和暂停监控项，将项目的监控项导出为 JSON 用于评审或备份，并可导入到别处。MCP 服务在 OAuth 授权后让 Claude、Cursor 等 Agent 拥有同样的能力，范围限于你选定的工作区和项目。",
        ),
        uses: ["REST API", "MCP", "JSON"],
      },
    ],
    statusPage: l(
      "Keep an internal or public status page for the services other teams and customers depend on. Group monitors by component, post updates as an incident moves through investigating, identified, monitoring and resolved, and let subscribers follow by email or RSS.",
      "为其他团队和客户所依赖的服务维护内部或公开的状态页。按组件对监控项分组，在事件经过调查中、已定位、观察中和已解决的过程中发布更新，并让订阅者通过邮件或 RSS 关注。",
    ),
    alerting: l(
      "Alert channels are Slack, Discord, Lark / Feishu, Telegram, PagerDuty, webhooks and email. A webhook receives a JSON POST, so it can feed a chat bot or your own tooling. Delivery results are logged per channel so you can see which alert went out and which failed.",
      "告警渠道包括 Slack、Discord、飞书 / Lark、Telegram、PagerDuty、Webhook 和邮件。Webhook 会收到一个 JSON POST，可接入聊天机器人或你自己的工具。每个渠道的发送结果都会记录，方便查看哪条告警已发出、哪条失败。",
    ),
    limits: [
      l("No on-call rotation schedules or phone-call paging; escalation is by channel and minutes unacknowledged.", "没有值班排班表和电话告警；升级按渠道和未确认的分钟数进行。"),
      l("Database monitors check reachability only.", "数据库监控只检查连通性。"),
      l("No TLS certificate expiry or ICMP ping monitors.", "没有 TLS 证书到期和 ICMP ping 监控。"),
      l("Multi-region covers HTTP, TCP and WebSocket monitors only.", "多区域检测仅适用于 HTTP、TCP 和 WebSocket 监控。"),
    ],
    faq: [
      {
        q: l("How does OpenUptime avoid alerting for a single region failing?", "OpenUptime 如何避免因单个区域故障而告警？"),
        a: l(
          "With several regions, a run fails only when most of the regions that answered failed, or when the number you set in the monitor settings fail. A tie counts as up.",
          "使用多个区域时，只有多数应答区域失败，或达到你在监控设置里指定的失败数量，本次检测才判定失败。票数相同时视为正常。",
        ),
      },
      {
        q: l("Can I monitor services on a private network?", "能监控私有网络中的服务吗？"),
        a: l(
          "On a self-hosted instance, yes, after the operator sets ALLOW_PRIVATE_TARGETS=true. The hosted service and Cloudflare Workers cannot reach private ranges.",
          "在自托管实例上可以，前提是运维设置 ALLOW_PRIVATE_TARGETS=true。托管服务和 Cloudflare Workers 无法访问私有网段。",
        ),
      },
      {
        q: l("Is there a Terraform provider?", "有 Terraform provider 吗？"),
        a: l(
          "No. Use the REST API or the JSON import and export to keep monitors in version control and apply them with a script.",
          "没有。请使用 REST API 或 JSON 导入导出，把监控项纳入版本控制，并用脚本应用。",
        ),
      },
    ],
  },
];
