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
    id: "domain-registration-expiry", date: "2026-10-29", edition: "community",
    title: { en: "Domain registration expiry", zh: "域名注册到期检测" },
    summary: { en: "Get a warning before a domain registration runs out.", zh: "域名注册到期前提前收到提醒。" },
    points: [
      { en: "Add a domain monitor and choose a warning window from 1 to 365 days; when the expiry date cannot be read, the monitor shows unknown, never healthy.", zh: "添加域名监控并设置 1 至 365 天的预警窗口；无法获取到期日时显示为未知，不会视为正常。" },
      { en: "Domain checks run between once an hour and once a day, and the expiry date is looked up through RDAP.", zh: "域名检测的间隔为每小时一次至每天一次，到期日通过 RDAP 查询。" },
      { en: "Alerts tell apart an unknown date, an upcoming expiry and a registration that has already expired.", zh: "告警区分日期未知、即将到期和已经过期三种情况。" },
      { en: "Public status pages show unknown registration data separately from service outages.", zh: "公开状态页将未知的注册信息与服务中断分开显示。" },
    ],
    link: { href: "/docs/api", label: { en: "Read the API docs", zh: "阅读 API 文档" } },
  },
  {
    id: "recurring-maintenance", date: "2026-10-29", edition: "community",
    title: { en: "Repeat maintenance windows", zh: "周期维护窗口" },
    summary: { en: "Schedule daily or weekly maintenance in a named time zone with an end date.", zh: "可按指定时区安排每日或每周的维护，并设置截止日期。" },
    points: [
      { en: "A repeating window keeps the same local start time across daylight-saving changes, and each occurrence shows on status pages.", zh: "周期维护的开始时间按当地时间保持不变，会随夏令时调整，每次维护都会显示在状态页上。" },
      { en: "Skip one occurrence, end an active window early, or cancel the rest of a series without losing finished windows.", zh: "可跳过单次维护、提前结束正在进行的窗口，或取消系列的其余部分，已完成的窗口会保留。" },
      { en: "The same actions are available through the API and MCP tools.", zh: "API 和 MCP 工具也提供同样的操作。" },
    ],
    link: { href: "/docs/api", label: { en: "Read the maintenance API docs", zh: "阅读维护 API 文档" } },
  },
  {
    id: "monitor-time-coverage", date: "2026-10-29", edition: "community",
    title: { en: "Monitor time coverage", zh: "监控时间覆盖报告" },
    summary: { en: "See how much of the last 7 or 30 days a monitor was up, down, degraded, paused or unknown.", zh: "查看监控项在过去 7 天或 30 天内处于正常、故障、缓慢、暂停或未知状态的时长。" },
    points: [
      { en: "Time with no fresh check result counts as unknown and is never shown as healthy.", zh: "没有有效检测结果的时间计为未知，不会显示为正常。" },
      { en: "Open the report from a monitor's page, read it through the API or MCP, or export it as JSON.", zh: "可在监控项页面查看报告，也可通过 API 或 MCP 读取，或导出为 JSON。" },
      { en: "History from before this update stays unknown.", zh: "此次更新之前的历史保持为未知。" },
      { en: "Maintenance time is included, and the report estimates coverage from check results rather than exact outage length or an SLA.", zh: "统计包含维护时间；报告根据检测结果推断覆盖时长，不是精确的停机时长或 SLA。" },
    ],
    link: { href: "/docs/api", label: { en: "Read the API docs", zh: "阅读 API 文档" } },
  },
  {
    id: "monitor-import-preview", date: "2026-10-29", edition: "community",
    title: { en: "Preview monitor imports", zh: "监控项导入预览" },
    summary: { en: "Review import warnings and duplicates before creating monitors.", zh: "创建监控项前，先查看导入警告和重复项。" },
    points: [
      { en: "Preview validates records and plan capacity without creating monitors or sending alerts.", zh: "预览会验证记录和套餐容量，不创建监控项，也不发送告警。" },
      { en: "Stable source IDs ignore surrounding whitespace and make repeated and concurrent imports safe; existing monitors are skipped rather than overwritten.", zh: "稳定的来源 ID 忽略首尾空白，可避免重复或并发导入产生重复记录，已有监控项会跳过，不会覆盖。" },
      { en: "Review per-record outcomes through the dashboard, REST API or MCP, including unsupported fields and region adjustments.", zh: "在控制台、REST API 或 MCP 中查看逐条结果，包括不支持的字段和区域调整。" },
      { en: "Records with masked headers, or with an unsupported body or authentication field (such as basic_auth_user or oauth_token), are now skipped instead of being imported without their credentials.", zh: "带有已遮蔽请求头、或不支持的请求体和认证字段（如 basic_auth_user、oauth_token）的记录现在会被跳过，不会在丢失凭据的情况下导入。" },
      { en: "A skipped duplicate shows the monitor that already holds its source ID, with a warning if its name or target differs; the preview names the destination project.", zh: "被跳过的重复记录会显示已占用该来源 ID 的监控项，名称或目标不同时给出提示；预览中会显示目标项目名称。" },
      { en: "Importing past your plan's active monitor limit is refused with the same error fields as creating one monitor, and the batch detail under capacity.", zh: "导入超出套餐的活跃监控项上限时，返回的错误字段与创建单个监控项时相同，批量详情放在 capacity 中。" },
    ],
    link: { href: "/docs/api#monitors", label: { en: "Read the import API docs", zh: "阅读导入 API 文档" } },
  },
  { id: "ntfy-alerts", date: "2026-10-29", edition: "community",
    title: { en: "ntfy alerts", zh: "ntfy 告警" },
    summary: { en: "Publish monitor alerts to ntfy.sh or your own ntfy server.", zh: "将监控告警发布到 ntfy.sh 或自己的 ntfy 服务器。" },
    points: [
      { en: "Configure a topic, optional access token and priority, then send a test message.", zh: "配置主题、可选访问令牌和优先级，并发送测试消息。" },
      { en: "Incident notifications use delivery history and retries; long messages are shortened without becoming attachments.", zh: "事件通知沿用投递记录与重试；长消息会截短，不会变成附件。" },
      { en: "The topic is masked like a secret, a token is only sent to https servers, and clearing the token field removes it.", zh: "主题会像密钥一样被遮蔽，令牌只会发送到 https 服务器，清空令牌输入框即可移除令牌。" },
    ],
    link: { href: "/docs/api", label: { en: "Read the channels API docs", zh: "阅读告警渠道 API 文档" } },
  },
  {
    id: "recovery-threshold", date: "2026-10-29", edition: "community",
    title: { en: "Wait for stable recovery", zh: "确认稳定恢复后再通知" },
    summary: { en: "Require several consecutive successes before an outage is marked as recovered.", zh: "可要求连续多次成功后才结束宕机，减少反复恢复通知。" },
    points: [
      { en: "Choose between one and ten successful checks or heartbeat pings before an outage ends; the default stays at one.", zh: "可设置结束宕机前需要一到十次成功检测或心跳，默认仍为一次。" },
      { en: "A failed check starts the count over, and a multi-region check counts as one success, while uptime figures still reflect every individual result.", zh: "检测失败会让计数重新开始，多区域检测只算一次成功，可用率仍按每次实际结果计算。" },
      { en: "Every heartbeat ping counts, even several arriving close together.", zh: "每次心跳都会计数，即使几次心跳间隔很短。" },
      { en: "Running a check by hand on a paused monitor no longer changes its status, and saving a running monitor as not paused keeps its status and progress.", zh: "对已暂停的监控手动检测不再改变其状态；把正在运行的监控保存为未暂停也不会重置状态和恢复进度。" },
    ],
    link: { href: "/docs/api#monitors", label: { en: "Read about the recovery threshold", zh: "阅读恢复阈值说明" } },
  },
  {
    id: "http-request-bodies", date: "2026-10-29", edition: "community",
    title: { en: "HTTP request bodies", zh: "HTTP 请求体" },
    summary: { en: "Monitor API endpoints with custom request bodies and additional HTTP methods.", zh: "通过自定义请求体和更多 HTTP 方法检测 API 接口。" },
    points: [
      { en: "Send up to 16 KiB of UTF-8 text with POST, PUT, PATCH, DELETE or OPTIONS; the form counts bytes and the runtime calculates Content-Length.", zh: "使用 POST、PUT、PATCH、DELETE 或 OPTIONS 发送最多 16 KiB 的 UTF-8 文本；表单按字节计数，运行时计算 Content-Length。" },
      { en: "Request bodies are masked for members and viewers. A redirect to another origin never carries your custom headers, and one that would resend the body there is refused.", zh: "成员和访客只能查看请求体掩码。重定向到其他源时不会携带自定义请求头，会重新发送请求体的跨源重定向会被拒绝。" },
      { en: "Upgrade remote probes before using request bodies; incompatible probes are reported as unavailable.", zh: "使用请求体前请升级远程探针；不兼容的探针会被标记为不可用。" },
      { en: "The account data export now includes request bodies for workspaces you own or administer.", zh: "账号数据导出现在会包含你拥有或管理的工作区中的请求体。" },
    ],
    link: { href: "/docs/api", label: { en: "Read the monitor API docs", zh: "阅读监控 API 文档" } },
  },
  {
    id: "teams-alerts", date: "2026-10-29", edition: "community",
    title: { en: "Microsoft Teams alerts", zh: "Microsoft Teams 告警" },
    summary: { en: "Send monitor alerts through a Teams Workflow webhook.", zh: "通过 Teams 工作流 Webhook 接收监控告警。" },
    points: [
      { en: "Add a channel with a Workflow webhook URL whose authentication is set to “Anyone”, then send a test before connecting monitors.", zh: "添加身份验证设为“任何人”的工作流 Webhook URL，发送测试消息后再关联监控。" },
      { en: "Monitor names and URLs are shown as plain text, so characters such as * _ and [ ] do not change the formatting; messages over 4000 characters are shortened.", zh: "监控名称和网址按纯文本显示，* _ [ ] 等字符不会改变格式；超过 4000 个字符的消息会被截短。" },
      { en: "Outages, recoveries and escalations use the existing delivery history and retries; delivery confirms webhook acceptance, not completion of the workflow.", zh: "故障、恢复和升级通知沿用现有投递记录与重试；投递成功表示 Webhook 已接收，不代表工作流已执行完成。" },
      { en: "If Teams answers 401 or 403, the delivery history says the Workflow must not require sign-in.", zh: "如果 Teams 返回 401 或 403，投递记录会提示该工作流不能要求登录验证。" },
    ],
  },
  {
    id: "discord-alerts",
    date: "2026-10-29",
    edition: "community",
    title: { en: "Discord alerts", zh: "Discord 告警" },
    summary: { en: "Send monitor alerts to a Discord channel using its webhook.", zh: "通过频道 Webhook 将监控告警发送到 Discord。" },
    points: [
      { en: "Add a Discord channel in Alerting and send a test before connecting monitors.", zh: "在告警设置中添加 Discord 渠道，发送测试消息后再关联监控。" },
      { en: "Outages, recoveries and escalations use the existing delivery log and retry handling; message text cannot ping users or roles.", zh: "故障、恢复和升级通知沿用投递记录与重试机制；消息文本不会触发用户或角色提及通知。" },
    ],
  },
  {
    id: "dns-record-assertions", date: "2026-10-29", edition: "community",
    title: { en: "Check DNS record values", zh: "校验 DNS 记录值" },
    summary: { en: "Monitor A, AAAA, CNAME, MX, TXT and NS records with optional value matching.", zh: "支持监控 A、AAAA、CNAME、MX、TXT 和 NS 记录，并可校验期望值。" },
    points: [
      { en: "Require one answer to match an exact value or contain text; unrelated record types no longer count as success.", zh: "可要求至少一条记录完全匹配期望值或包含指定文本；其他类型的记录不再被误判为成功。" },
      { en: "Unicode domain names use IDNA; exact IPv4 values ignore surrounding whitespace and normalize dotted decimal octets.", zh: "Unicode 域名按 IDNA 规范化；IPv4 完全匹配会忽略首尾空白并规范化点分十进制数值。" },
      { en: "Configure DNS checks in the dashboard, API or MCP, and preserve their settings when exporting and importing monitors.", zh: "可通过控制台、API 或 MCP 配置 DNS 检测，导入导出时会保留这些设置。" },
      { en: "Existing DNS monitors now need an address record: a name that only has a CNAME, or no A record at all, now fails, so some monitors may start alerting after you upgrade.", zh: "已有的 DNS 监控现在要求存在地址（A）记录：只有 CNAME 或没有 A 记录的域名会判定为失败，升级后部分监控可能开始告警。" },
    ],
    link: { href: "/docs/api", label: { en: "Read the monitor API docs", zh: "阅读监控 API 文档" } },
  },
  { id: "alert-routing-policy", date: "2026-10-29", edition: "community",
    title: { en: "Alert routing policy hook", zh: "告警路由策略扩展" },
    summary: { en: "Custom deployments can select which eligible channels receive an incident notification.", zh: "定制部署可以从符合条件的渠道中选择事件通知接收方。" },
    points: [
      { en: "Policies run before sending, record skipped channels, and retry unavailable decisions without changing the original routing time.", zh: "策略在发送前执行，记录跳过的渠道；策略暂不可用时会重试，并保留原路由时间。" },
      { en: "Only an explicit boolean approval permits sending; malformed policy results are denied.", zh: "只有明确的布尔值 true 才允许发送，策略返回格式错误时拒绝发送。" },
      { en: "While a policy is unavailable, alerts keep waiting for a decision instead of failing after three tries.", zh: "策略暂不可用期间，告警会持续等待决定，不再三次尝试后直接失败。" },
      { en: "The default routing is unchanged; the hook does not add on-call schedules or rotation management.", zh: "默认路由保持原样；扩展接口不包含值班排班或轮换管理。" },
    ],
  },
  { id: "status-delivery-policy", date: "2026-10-29", edition: "community",
    title: { en: "Status delivery policy hooks", zh: "状态页分发策略扩展" },
    summary: { en: "Custom deployments can apply one access policy to status pages, feeds and subscriber notifications.", zh: "定制部署可以为状态页、订阅源和订阅通知设置统一的访问策略。" },
    points: [
      { en: "Policy-enabled status responses bypass shared caches, and server-rendered pages preserve visitor cookies and private caching rules.", zh: "启用策略的状态页响应绕过共享缓存，服务端渲染会保留访客 Cookie 并遵循私有缓存规则。" },
      { en: "Subscriber policies require explicit approval, run with bounded concurrency, and record denials or sanitized failures in alert history.", zh: "订阅策略仅接受明确授权，限制并发执行数量，并在告警历史记录拒绝或脱敏后的失败。" },
      { en: "Default Community pages remain public; these hooks do not add membership, invitations or a private-page UI.", zh: "Community 默认状态页仍公开；扩展接口不包含成员管理、邀请或私有页面界面。" },
    ],
  },
  {
    id: "edition-request-middleware", date: "2026-10-29", edition: "community",
    title: { en: "Edition request extensions", zh: "版本请求扩展" },
    summary: { en: "Custom editions can wrap existing API requests through a supported middleware hook.", zh: "自定义版本可以通过受支持的中间件接口扩展现有 API 请求处理。" },
    points: [
      { en: "The hook surrounds public, authentication and authenticated routes, including internal REST calls made by MCP tools.", zh: "接口覆盖公开、认证及已登录路由，也包括 MCP 工具发起的内部 REST 请求。" },
      { en: "Authenticated requests expose verified session, API-key or OAuth attribution without exposing credentials.", zh: "已认证请求提供经验证的会话、API key 或 OAuth 归因信息，不暴露凭据值。" },
      { en: "Extensions can await the result while the request database remains open; Community behavior stays unchanged without an extension.", zh: "扩展可以在请求数据库关闭前等待处理结果；不配置扩展时，Community 行为保持不变。" },
    ],
  },
  {
    id: "migration-history-validation", date: "2026-10-29", edition: "community",
    title: { en: "Validate migration history", zh: "校验数据库迁移历史" },
    summary: { en: "Migrations stop with an error when a build does not match the database history.", zh: "部署版本与数据库迁移历史不一致时，迁移会明确报错并停止。" },
    points: [
      { en: "Out-of-order or changed migrations are no longer silently skipped; both migration entry points serialize concurrent runs.", zh: "乱序或被修改的迁移不会再被静默跳过，两种迁移入口均串行处理并发运行。" },
      { en: "Run the migration with --check to validate a database against this version without changing it.", zh: "迁移命令加上 --check 可以只读校验数据库与当前版本是否一致，不会修改数据库。" },
    ],
    link: { href: "/docs/self-host", label: { en: "Read the self-hosting docs", zh: "阅读自托管文档" } },
  },
  {
    id: "loading-placeholders",
    date: "2026-10-29",
    edition: "community",
    title: { en: "Loading placeholders on lists", zh: "列表加载占位" },
    summary: { en: "The Monitors and Incidents pages now show placeholders while data loads instead of briefly looking empty.", zh: "监控和事件页面在加载数据时显示占位，不再先显示成空列表。" },
    points: [
      { en: "On a slow connection you no longer see “0” counts or an empty list before the real data arrives.", zh: "网络较慢时，不会再先看到“0”的计数或空列表，再等真实数据出现。" },
    ],
  },
  {
    id: "websocket-monitors",
    date: "2026-10-28",
    edition: "community",
    title: { en: "WebSocket monitors", zh: "WebSocket 监控" },
    summary: { en: "Monitor a ws:// or wss:// endpoint: the handshake is the check, and a message and its reply can be checked too.", zh: "可以监控 ws:// 或 wss:// 端点：以握手是否成功为准，也可以发送消息并校验回复。" },
    points: [
      { en: "A WebSocket monitor is up when the server completes the handshake; a refused upgrade, a redirect or a wrong accept header marks it down.", zh: "服务器完成握手即判定为正常；拒绝升级、返回重定向或 Accept 头不正确都会判定为故障。" },
      { en: "Optionally send a text message once connected; a reply must then arrive within the timeout.", zh: "可选：连接后发送一条文本消息，回复必须在超时时间内到达。" },
      { en: "Check the reply, or the first message the server sends, for a keyword that must or must not appear.", zh: "可以在回复（或服务器主动发来的第一条消息）中检查某个关键词必须出现或不得出现。" },
      { en: "Headers such as Authorization are sent with the handshake, and WebSocket monitors can be checked from several regions.", zh: "Authorization 等请求头会随握手一起发送，WebSocket 监控也支持多区域检测。" },
      { en: "Self-hosted probes need updating before they can run WebSocket checks.", zh: "自托管的探针需要更新后才能执行 WebSocket 检测。" },
    ],
    link: { href: "/docs/websocket", label: { en: "Read the WebSocket monitor docs", zh: "阅读 WebSocket 监控文档" } },
  },
  {
    id: "status-page-site-logo",
    date: "2026-10-24",
    edition: "community",
    title: { en: "Status page header and phone layout", zh: "状态页页头与手机布局" },
    summary: { en: "A status page shows your website's icon in the header, and the phone layout reads in a better order.", zh: "状态页页头显示你网站的图标，手机上的排布顺序也更合理。" },
    points: [
      { en: "The icon replaces the OpenUptime mark; without a website link the page looks as before.", zh: "该图标会替换 OpenUptime 的标志；没有设置网站链接的页面保持原样。" },
      { en: "On phones, the components and incidents come first and the subscribe box follows them.", zh: "手机上先显示组件和事件，订阅框排在它们后面。" },
    ],
  },
  {
    id: "monitor-list-interval",
    date: "2026-10-24",
    edition: "community",
    title: { en: "Check interval in the monitor list", zh: "监控列表显示并修改检测间隔" },
    summary: { en: "Each monitor in the list shows how often it is checked.", zh: "监控列表里的每个监控都会显示检测频率。" },
    points: [
      { en: "A small tag such as 1m or 5m sits next to the monitor type, so you no longer open a monitor to see its interval.", zh: "监控类型旁边新增 1m、5m 之类的小标签，不必点进监控就能看到检测间隔。" },
      { en: "Click the tag to pick 1, 5 or 15 minutes, then confirm to save it without opening the monitor.", zh: "点击标签可选择 1、5 或 15 分钟，确认后即保存，无需打开监控。" },
    ],
  },
  {
    id: "incident-list-long-notes",
    date: "2026-10-24",
    edition: "community",
    title: { en: "Incident list keeps its layout", zh: "事件列表排版修复" },
    summary: { en: "Long incident notes no longer run over the other columns.", zh: "过长的事件说明不再压到其他列上。" },
    points: [
      { en: "Titles and notes in the incident list are cut off with an ellipsis; the full note shows on hover.", zh: "事件列表里过长的标题和说明会以省略号截断，悬停可查看完整说明。" },
    ],
  },
  {
    id: "status-page-subscribe-form-tidy",
    date: "2026-10-23",
    edition: "community",
    title: { en: "Cleaner subscribe form", zh: "订阅表单更整洁" },
    summary: { en: "The component picker on a status page's subscribe form reads like the text above it.", zh: "状态页订阅表单里的组件选择，样式与上方说明文字保持一致。" },
    points: [
      { en: "The “Only these components” hint is plain text instead of a label sitting on a box border.", zh: "“仅订阅这些组件”的提示改为普通文字，不再压在边框上。" },
      { en: "The component list is collapsed by default and opens when you click the hint.", zh: "组件列表默认折叠，点击提示后展开。" },
    ],
    cloud: { en: "On a custom status page domain, the RSS, maintenance calendar and llms.txt links no longer return 404.", zh: "在自定义状态页域名上，RSS、维护日历和 llms.txt 链接不再返回 404。" },
  },
  {
    id: "pause-refresh-in-background-tabs",
    date: "2026-10-23",
    edition: "community",
    title: { en: "No refreshing in background tabs", zh: "后台标签页不再刷新" },
    summary: { en: "Pages that refresh themselves now stop while their tab is hidden.", zh: "会自动刷新的页面，在标签页隐藏时不再发起请求。" },
    points: [
      { en: "The monitor list and monitor detail stop polling while the tab is in the background.", zh: "监控列表和监控详情在标签页位于后台时不再轮询。" },
      { en: "When you switch back, the page fetches fresh data once right away.", zh: "切回标签页时，页面会立即抓取一次最新数据。" },
    ],
    cloud: { en: "The custom-domain status on a status page follows the same rule.", zh: "状态页上的自定义域名状态同样遵循这一规则。" },
  },
  {
    id: "heartbeat-manual-check-guard",
    date: "2026-10-23",
    edition: "community",
    title: { en: "Keep heartbeat deadlines intact", zh: "避免心跳手动检测误报" },
    summary: { en: "Heartbeats wait for incoming pings and no longer offer a manual check.", zh: "心跳监控等待任务上报，不再提供手动检测。" },
    points: [{ en: "Manual check requests are refused without changing heartbeat status, history or its deadline.", zh: "手动检测请求会被拒绝，不会改变心跳状态、历史或截止时间。" }],
  },
  {
    id: "deduplicate-delayed-check-runs",
    date: "2026-10-23",
    edition: "community",
    title: { en: "Skip delayed duplicate checks", zh: "跳过延迟重复检测" },
    summary: { en: "A delayed queue retry no longer repeats a check after a newer run has started.", zh: "新一轮检测开始后，旧队列消息的重试不会再重复执行检测。" },
    points: [{ en: "Changing the check interval keeps new runs working while old retries remain suppressed.", zh: "修改检测间隔后，新检测照常运行，旧消息仍会被去重。" }],
    cloud: { en: "Delayed duplicate runs no longer consume extra check credits.", zh: "延迟重复的检测不再额外消耗检测额度。" },
  },
  {
    id: "protected-monitor-request-settings",
    date: "2026-10-23",
    edition: "community",
    title: { en: "Protected monitor request settings", zh: "保护监控请求设置" },
    summary: { en: "Changing request settings while retaining stored headers now requires an owner or admin.", zh: "保留已有请求头时，修改请求设置现在需要所有者或管理员权限。" },
    points: [{ en: "Members can still edit monitoring settings and replace a request with headers they supply themselves.", zh: "成员仍可编辑监控设置，或使用自己提供的请求头替换整个请求。" }],
    link: { href: "/docs/api", label: { en: "Read the API docs", zh: "阅读 API 文档" } },
  },
  {
    id: "workspace-access-revocation",
    date: "2026-10-23",
    edition: "community",
    title: { en: "Workspace access follows membership", zh: "工作区访问权限即时更新" },
    summary: { en: "Removing a member now revokes access through their existing sessions.", zh: "移除成员后，其已有登录会话也会失去工作区访问权限。" },
    points: [{ en: "Workspace permissions are checked against current membership on each request.", zh: "每次访问工作区时都会核对当前成员身份。" }],
  },
  {
    id: "clearer-mcp-tools",
    date: "2026-10-23",
    edition: "community",
    title: { en: "Clearer MCP tool guidance", zh: "更清晰的 MCP 工具说明" },
    summary: { en: "MCP tools explain their inputs, results and effects so agents can choose and call them more reliably.", zh: "MCP 工具补充了参数、返回结果和操作影响说明，帮助智能体正确选择和调用。" },
    points: [
      { en: "Monitor arguments explain units, discovery sources, replacement lists and how to clear optional settings.", zh: "监控参数说明了单位、可选值来源、列表替换和清除可选设置的方式。" },
      { en: "Tool descriptions distinguish configuration edits, pausing, incident updates and public status queries, including their effects on checks and notifications.", zh: "工具说明明确区分配置修改、暂停、事件更新和公开状态查询，并说明对检测与通知的影响。" },
      { en: "Public status tools use get_public_status_page, list_public_status_page_incidents and list_public_status_page_maintenance; old invocation names remain supported.", zh: "公开状态工具改用 get_public_status_page、list_public_status_page_incidents 和 list_public_status_page_maintenance，旧调用名称继续兼容。" },
    ],
    link: { href: "/docs/mcp", label: { en: "Read the MCP docs", zh: "阅读 MCP 文档" } },
  },
  {
    id: "hover-feedback",
    date: "2026-10-23",
    edition: "community",
    title: { en: "Hover feedback and a steadier form", zh: "悬停反馈与更稳的表单" },
    summary: {
      en: "Controls react when you point at them, and the monitor form is harder to lose by accident.",
      zh: "控件在鼠标悬停时有了反馈，监控表单也不容易被误关。",
    },
    points: [
      { en: "The monitor form no longer closes when you click outside it, so a stray click cannot throw away what you typed; it has a close button in the top right.", zh: "监控表单不再因点击外部而关闭，误点不会丢掉已填内容，右上角新增了关闭按钮。" },
      { en: "The form's title, the monthly check estimate and the buttons stay in place while the fields in between scroll.", zh: "表单的标题、每月检测次数估算和按钮固定不动，中间的字段区域单独滚动。" },
      { en: "An info icon next to Depends on explains what a dependency is.", zh: "「依赖于」旁新增说明图标，悬停即可了解什么是依赖。" },
      { en: "Buttons, icon buttons, tabs, segmented controls and option cards change background or border on hover.", zh: "按钮、图标按钮、标签页、分段选择和选项卡片在悬停时会改变背景或边框。" },
      { en: "Links in the sidebar, docs, changelog and public pages are underlined or dimmed on hover, and buttons sink slightly when pressed.", zh: "侧边栏、文档、更新日志和公开页面中的链接在悬停时会出现下划线或变淡，按钮按下时会轻微下沉。" },
    ],
  },
  {
    id: "redirect-monitoring",
    date: "2026-10-23",
    edition: "community",
    title: { en: "Pick the expected status, check redirects", zh: "状态码改为选择，支持检查跳转" },
    summary: {
      en: "The expected status of an HTTP monitor is now chosen from a list, and a monitor that expects a redirect checks where it leads.",
      zh: "HTTP 监控的期望状态码改为下拉选择；期望跳转时，还能检查跳转的目的地。",
    },
    points: [
      { en: "Choose the expected status from the common ones instead of typing a number; a monitor with an unusual value keeps it.", zh: "期望状态码从常用值中选择，不用再手填数字；已有的特殊值会保留。" },
      { en: "With 301, 302, 303, 307 or 308 expected, the redirect is no longer followed, so the monitor passes on the redirect itself instead of failing on the page it leads to.", zh: "期望 301、302、303、307 或 308 时不再跟随跳转，监控按跳转本身判断，不会因为目的页面的状态码而失败。" },
      { en: "Optionally set where the redirect must lead, as a full URL or a path; a different Location fails the check and the error shows both.", zh: "可选填跳转必须指向的地址（完整 URL 或路径）；Location 不一致时检测失败，错误信息会同时显示实际值和期望值。" },
    ],
    link: { href: "/docs/api", label: { en: "Read the API docs", zh: "阅读 API 文档" } },
  },
  {
    id: "mcp-refresh-discovery",
    date: "2026-10-23",
    edition: "community",
    title: { en: "Discover MCP token renewal", zh: "MCP 令牌续期发现" },
    summary: { en: "MCP clients can discover the scope needed to request renewable access.", zh: "MCP 客户端现在可以发现申请可续期访问所需的权限。" },
    points: [{ en: "OAuth discovery advertises offline_access so clients can request a refresh token when connecting.", zh: "OAuth 发现文档公布 offline_access，方便客户端在连接时申请刷新令牌。" }],
    link: { href: "/docs/mcp", label: { en: "Read the MCP docs", zh: "阅读 MCP 文档" } },
  },
  {
    id: "password-changed-email",
    date: "2026-10-23",
    edition: "community",
    title: { en: "Email after a password reset", zh: "重置密码后发送邮件通知" },
    summary: {
      en: "When a password is changed with a reset link, the account's email address gets a notice.",
      zh: "通过重置链接修改密码后，账号邮箱会收到一封通知。",
    },
    points: [
      { en: "Resetting a password also signs the account out on every device.", zh: "重置密码后，该账号在所有设备上的登录都会退出。" },
      { en: "The email says the password was changed and links to a new reset, in case it wasn't you; it never contains the password or a token.", zh: "邮件说明密码已被更改，并附上再次重置的链接，以防不是本人操作；邮件中不含密码或令牌。" },
    ],
  },
  {
    id: "repeated-language-prefix-404",
    date: "2026-10-22",
    edition: "community",
    title: { en: "Repeated language prefix returns 404", zh: "重复的语言前缀返回 404" },
    summary: {
      en: "Addresses such as /zh-Hans/zh-Hans/status/example are no longer served as pages.",
      zh: "类似 /zh-Hans/zh-Hans/status/example 的地址不再被当作页面返回。",
    },
    points: [
      { en: "Search engines can no longer index endless copies of a page under a repeated /zh-Hans prefix.", zh: "搜索引擎不会再收录同一页面在重复 /zh-Hans 前缀下的无限副本。" },
    ],
  },
  {
    id: "node-security-release",
    date: "2026-10-22",
    edition: "community",
    title: { en: "Patched Node.js in Docker images", zh: "Docker 镜像升级到已修复的 Node.js" },
    summary: {
      en: "The Docker images now pin Node.js 22.23.4, which fixes the security issues in the 21 October Node.js releases.",
      zh: "Docker 镜像现在固定使用 Node.js 22.23.4，修复了 10 月 21 日 Node.js 安全版本中的漏洞。",
    },
    points: [
      {
        en: "The server and probe images build on node:22.23.4-alpine instead of a floating 22 tag.",
        zh: "服务端和探针镜像基于 node:22.23.4-alpine 构建，不再使用浮动的 22 标签。",
      },
      {
        en: "If you run the probe or server on your own Node.js, update to 22.23.4, 24.22.1 or 26.12.1; the supported range in package.json now says so.",
        zh: "如果你用自己的 Node.js 运行探针或服务端，请升级到 22.23.4、24.22.1 或 26.12.1；package.json 中的受支持版本范围已同步更新。",
      },
    ],
  },
  {
    id: "alerts-name-project",
    date: "2026-10-19",
    edition: "community",
    title: { en: "Alerts name the project", zh: "告警标明所属项目" },
    summary: {
      en: "When a workspace has several projects, every alert now says which project the monitor belongs to.",
      zh: "工作区有多个项目时，每条告警都会注明监控所属的项目。",
    },
    points: [
      { en: "Slack, Lark, Telegram and PagerDuty messages, push notifications and the subject of alert emails start with the project name in brackets, for example \"[favicon.im] WWW homepage is down\"; reminders, escalations and recovery messages do too.", zh: "Slack、飞书、Telegram、PagerDuty 消息、推送通知以及告警邮件主题都会以方括号标出项目名，例如“[favicon.im] WWW homepage is down”；提醒、升级和恢复消息同样如此。" },
      { en: "Alert emails also list the project in their details.", zh: "告警邮件的详情中也会列出所属项目。" },
      { en: "Webhook payloads always include a project field with the project's id and name.", zh: "Webhook 负载始终包含 project 字段，内含项目的 id 和名称。" },
      { en: "A workspace with a single project sees the same alerts as before.", zh: "只有一个项目的工作区，告警内容与之前完全相同。" },
    ],
  },
  {
    id: "workspace-menu-polish",
    date: "2026-10-19",
    edition: "community",
    title: { en: "Clearer project switcher and All projects view", zh: "更清晰的项目切换器与所有项目视图" },
    summary: {
      en: "The project switcher shows how many projects there are and that its list scrolls, and the All projects view is easier to follow.",
      zh: "项目切换器会显示项目数量并明确提示列表可滚动，“所有项目”视图也更易于使用。",
    },
    points: [
      { en: "The Projects and Workspaces headings show a count, and a long list fades at the edge that has more rows and has a slim scrollbar.", zh: "“项目”和“工作区”标题旁显示数量，较长的列表会在还有更多内容的一侧渐隐，并带有细滚动条。" },
      { en: "The All projects entry stays pinned above the scrolling project list.", zh: "“所有项目”一项固定在可滚动的项目列表上方。" },
      { en: "Project cards say \"1 monitor\" and \"1 open incident\" instead of \"1 monitors\".", zh: "项目卡片中的数量文案已修正，单数时不再显示复数形式。" },
      { en: "Monitors and Incidents show an All projects label beside the title while that view is active.", zh: "启用“所有项目”视图时，监控项和事件页面的标题旁会显示“所有项目”标签。" },
      { en: "The back link on a monitor, incident or status page opened from All projects returns to that view.", zh: "从“所有项目”打开监控项、事件或状态页后，返回链接会回到该视图。" },
    ],
  },
  {
    id: "all-projects-view",
    date: "2026-10-19",
    edition: "community",
    title: { en: "See all projects at once", zh: "一览所有项目" },
    summary: {
      en: "The project switcher has a new All projects view that lists monitors and incidents from every project in the workspace.",
      zh: "项目切换器新增“所有项目”视图，可在一处查看工作区内所有项目的监控项和事件。",
    },
    points: [
      { en: "Monitors and incidents show a project badge on each row, and a summary card per project shows its monitors, down count and open incidents.", zh: "监控项和事件的每一行都带有项目标记，每个项目还有一张摘要卡片，显示监控数、故障数和未解决事件数。" },
      { en: "The view is read-only: pages that belong to one project ask you to choose a project, and opening a monitor or incident switches to its project.", zh: "该视图为只读：属于单个项目的页面会提示先选择项目，打开某个监控项或事件时会切换到它所在的项目。" },
      { en: "The API accepts x-project-id: all for reads, and GET /projects/overview returns per-project totals; writes in this mode return 400.", zh: "API 的读取请求可使用 x-project-id: all，GET /projects/overview 返回各项目汇总；此模式下的写入请求返回 400。" },
    ],
    link: { href: "/docs/api", label: { en: "Read the API docs", zh: "阅读 API 文档" } },
  },
  {
    id: "docs-fixes-3",
    date: "2026-10-17",
    edition: "community",
    title: { en: "Clearer subscription docs and small fixes", zh: "更清晰的订阅文档与小修复" },
    summary: {
      en: "The subscribe docs now describe what happens when an address subscribes twice, and a postmortem goes private when a new update reopens its incident.",
      zh: "订阅文档现在写明同一邮箱重复订阅时的处理方式；新的更新重新打开事件时，已发布的复盘会转为私有。",
    },
    points: [
      { en: "Subscribing again replaces the language and components of a pending address and sends the confirmation email again; a confirmed address gets no mail and no change.", zh: "重复订阅时，待确认的邮箱会以最新的语言和组件覆盖原有选择并再次收到确认邮件；已确认的邮箱不会收到邮件，也不会有改动。" },
      { en: "The per-address subscribe limit is shared by everyone, so someone else can delay your confirmation mail by submitting your address repeatedly.", zh: "每个邮箱的订阅限流对所有人共用，他人反复提交你的邮箱，可能会延迟你的确认邮件。" },
      { en: "Posting a non-resolved update to a resolved incident reopens it and withdraws its published postmortem, the same as an automatic reopen.", zh: "对已解决的事件发布未解决状态的更新会重新打开它，并撤回已发布的复盘，与自动重开的处理一致。" },
      { en: "On the status page, maintenance times are marked up as dates for browsers and readers.", zh: "状态页上的维护时间现在带有机器可读的日期标记。" },
    ],
    link: { href: "/docs/api", label: { en: "Read the API docs", zh: "阅读 API 文档" } },
  },
  {
    id: "reliability-fixes-4",
    date: "2026-10-17",
    edition: "community",
    title: { en: "More reliable alerts and checks", zh: "更可靠的告警与检测" },
    summary: {
      en: "Fewer missed \"down again\" alerts, fewer false outages from a prober that is offline, and safer retries.",
      zh: "减少漏发的“再次故障”告警，减少探测节点自身断网造成的误报，并让重试更安全。",
    },
    points: [
      { en: "A monitor that fails again after its recovery alert went out now always sends a \"down again\" alert; only flapping whose recovery was never announced stays quiet.", zh: "恢复告警已经发出后再次故障，现在一定会发送“再次故障”告警；只有恢复本身未通知过的反复抖动才会保持静默。" },
      { en: "An incident that was held back as flapping still gets its reminders and escalations if it keeps going.", zh: "因抖动被压制的事件，如果持续不恢复，仍会按设置发送提醒和升级通知。" },
      { en: "A failure that mixes a timeout with a network error on this machine is no longer mistaken for the prober being offline.", zh: "超时与本机网络错误混合出现的失败，不再被误判为探测节点自身断网。" },
      { en: "Reminders no longer stall behind many incidents that are under maintenance, and a person's manual resolve only suppresses the outage it belonged to.", zh: "提醒不再被大量处于维护期的事件堵住；人工解决只会抑制它所属的那一次故障。" },
      { en: "Checks no longer repeat a request that timed out after it was sent, and a mail provider error that is not about headers no longer causes a second email.", zh: "请求发出后超时不再被重复发送；与邮件头无关的邮件服务错误也不再导致重复发信。" },
    ],
  },
  {
    id: "zh-seo-metadata",
    date: "2026-10-17",
    edition: "community",
    title: { en: "Chinese titles for comparison pages", zh: "对比页的中文标题与描述" },
    summary: {
      en: "The Chinese versions of the alternatives and use-case pages now carry a Chinese title, description and FAQ data for search and link previews.",
      zh: "替代方案与使用场景页面的中文版现在带有中文标题、描述和常见问题数据，便于搜索引擎收录和链接预览。",
    },
    points: [
      { en: "Pages under /zh-Hans/alternatives and /zh-Hans/for no longer show the English title, description and share card text.", zh: "/zh-Hans/alternatives 与 /zh-Hans/for 下的页面不再显示英文标题、描述和分享卡片文字。" },
    ],
    link: { href: "/alternatives", label: { en: "See the comparison pages", zh: "查看对比页面" } },
  },
  {
    id: "public-surface-fixes-2",
    date: "2026-10-17",
    edition: "community",
    title: { en: "Status page and subscription fixes", zh: "状态页与订阅修复" },
    summary: {
      en: "Publishing or taking down a postmortem shows on the status page right away, and subscription and maintenance reminders are more dependable.",
      zh: "发布或撤下复盘后状态页会立即更新，订阅与维护提醒也更可靠。",
    },
    points: [
      { en: "Publishing or unpublishing a postmortem, opening an incident or posting an update refreshes the public status page at once on the instance that handled it; other instances catch up within 30 seconds.", zh: "发布或撤下复盘、创建事件、发布更新后，处理该请求的实例上的公开状态页会立即刷新；其他实例会在 30 秒内同步。" },
      { en: "Subscribing again before you confirm now keeps your newest language and component choice.", zh: "确认之前再次订阅，会保留你最新选择的语言和组件。" },
      { en: "A maintenance reminder is no longer held back by windows nobody follows, is not retried again and again when the plan's email allowance is used up, and is retried at most three times when every mail fails.", zh: "维护提醒不再被无人关注的维护窗口挤占；套餐邮件额度用完时不会每分钟重试；所有邮件都发送失败时最多重试三次。" },
      { en: "A status page without a project now lists the maintenance windows of the workspace's oldest project, like its incidents and subscribers.", zh: "未归属项目的状态页，现在与事件和订阅者一样，显示工作区最早项目的维护窗口。" },
      { en: "On Cloudflare, subscriber emails are still sent if the mail service rejects the unsubscribe headers.", zh: "在 Cloudflare 上，即使邮件服务拒绝退订邮件头，订阅者邮件仍会发出。" },
    ],
  },
  {
    id: "reliability-fixes-3",
    date: "2026-10-17",
    edition: "community",
    title: { en: "Fewer repeat alerts, steadier checks", zh: "减少重复告警，检测更稳" },
    summary: {
      en: "A monitor that keeps flipping no longer pages you over and over, and the next outage after you resolve an incident by hand alerts as usual.",
      zh: "反复抖动的监控项不再不停地提醒你；手动解决事件之后的下一次故障会照常告警。",
    },
    points: [
      { en: "The next outage after you resolve an incident yourself, in the app, with an API key or from an agent, alerts normally instead of being muted as flapping.", zh: "你手动（在应用内、通过 API Key 或智能体）解决事件后，下一次故障会照常告警，不会再被当作抖动静音。" },
      { en: "A monitor that goes down and up repeatedly sends at most one alert per 15 minutes for the same incident, as long as no recovery alert went out in between, and a retried alert for a reopened incident still says \"again\" on chat and webhook channels.", zh: "监控项反复下线、恢复时，只要期间没有发出过恢复告警，同一事件每 15 分钟最多告警一次；重试发送的重开事件告警在聊天和 Webhook 渠道中仍会写明“再次”。" },
      { en: "A published postmortem is withdrawn when its incident is reopened, so it is not republished by the next recovery.", zh: "事件被重新打开时，已发布的复盘会被撤回，不会在下一次恢复时再次公开。" },
      { en: "With ALLOW_PRIVATE_TARGETS on, the check that tells a down target from a prober without internet now still works for public names, and an unusable SELFCHECK_URLS logs a warning and falls back to the defaults.", zh: "开启 ALLOW_PRIVATE_TARGETS 后，用于区分目标故障与探测节点断网的自检对公网域名依然有效；SELFCHECK_URLS 无效时会记录警告并使用默认地址。" },
      { en: "A target with several addresses is no longer reported down only because one address hangs.", zh: "目标有多个地址时，不再因其中一个地址无响应而被判定为故障。" },
    ],
  },
  {
    id: "public-surface-fixes",
    date: "2026-10-17",
    edition: "community",
    title: { en: "Status page and API fixes", zh: "状态页与接口修复" },
    summary: {
      en: "Manual incidents stay on their own project's status pages, write-ups are published only when you say so, and subscribing is harder to abuse.",
      zh: "手动事件只出现在所属项目的状态页，复盘内容需要你确认才会公开，订阅接口也更难被滥用。",
    },
    points: [
      { en: "An incident without a monitor now shows only on the status pages and subscriber lists of its own project.", zh: "没有关联监控项的事件，现在只会出现在所属项目的状态页和订阅者通知中。" },
      { en: "Root cause and postmortem stay private until you tick Publish to the status page; write-ups saved before this change are private until you publish them again, and a resolved update can no longer be internal.", zh: "根因和复盘在你勾选「发布到状态页」之前保持私有；此前保存的内容需要重新发布才会公开，已解决的更新也不能再设为内部。" },
      { en: "Subscribing is limited per address, a confirmed address no longer receives repeat mail, and emails carry one-click unsubscribe (a confirmation page replaces the old link-click removal).", zh: "订阅按邮箱地址限速，已确认的地址不再收到重复邮件；邮件支持一键退订，退订链接会先显示确认页。" },
      { en: "The amber threshold on status pages defaults to 98%, maintenance reminders are retried when sending fails, and the public MCP toggle is worded clearly, with JSON-RPC batches capped at 10 requests.", zh: "状态页黄色阈值默认为 98%，维护提醒发送失败时会重试，公开 MCP 开关的说明更清晰，JSON-RPC 批量请求上限为 10 个。" },
      { en: "Status pages list upcoming and running maintenance windows, and documentation pages are included in the sitemap.", zh: "状态页会显示即将开始和进行中的维护窗口，文档页面也已加入站点地图。" },
    ],
    link: { href: "/docs/api", label: { en: "Read the API docs", zh: "阅读 API 文档" } },
  },
  {
    id: "reliability-fixes-2",
    date: "2026-10-17",
    edition: "community",
    title: { en: "More reliable incidents and checks", zh: "事件与检测更可靠" },
    summary: {
      en: "A reopened incident now tells you it is back, a person's resolution stands, and TCP and database checks try every address of a name.",
      zh: "重新打开的事件现在会通知你，人工解决的事件不会被自动重开，TCP 与数据库检测会依次尝试域名的所有地址。",
    },
    points: [
      { en: "When a monitor fails again within 10 minutes of recovering, the reopened incident is unacknowledged again, restarts its reminders and escalation, and sends a \"down again\" alert to chat and webhook channels (email and push alerts do not say \"again\").", zh: "监控项在恢复后 10 分钟内再次失败时，重新打开的事件会回到未确认状态，重新开始提醒和升级，并向聊天和 Webhook 渠道发送“再次故障”告警（邮件和推送告警不带“再次”字样）。" },
      { en: "An incident that a person resolved is never reopened by a later failure, and a monitor whose outage was muted by a dependency does not open an incident after a person resolved one meanwhile.", zh: "人工解决的事件不会被之后的失败重新打开；因依赖而被静音的监控项，在期间有人工解决事件后，也不会再补开事件。" },
      { en: "A queued alert retry is skipped when the incident has since been resolved (for a down alert) or reopened (for a recovery alert), and a reminder no longer uses up one of its repeats while a maintenance window silences it.", zh: "排队重试的告警在事件已解决（故障告警）或已重新打开（恢复告警）时会被跳过；维护窗口内被静音的提醒也不再消耗提醒次数。" },
      { en: "TCP and database checks try every address a name resolves to, IPv4 first, and report a failure from the checker's own network only when no address connected; a lookup that went stale is refreshed once after a failed connection.", zh: "TCP 与数据库检测会依次尝试域名解析出的所有地址（IPv4 优先），只有所有地址都无法连接时才会把检测端自身的网络故障判为无效结果；连接失败后会重新解析一次过期的 DNS 结果。" },
      { en: "Set SELFCHECK_URLS to choose the URLs used to tell a down target from an offline checker (empty turns it off); targets that resolve to private addresses skip it, and gzip or Brotli answers to pinned requests are decompressed.", zh: "可通过 SELFCHECK_URLS 指定用于区分目标故障与检测端断网的网址（留空则关闭）；解析到内网地址的目标会跳过该检查，固定地址请求收到的 gzip 或 Brotli 响应也会被正确解压。" },
    ],
  },
  {
    id: "comparison-and-use-case-pages",
    date: "2026-10-17",
    edition: "community",
    title: { en: "Comparison and use-case pages", zh: "对比与使用场景页面" },
    summary: {
      en: "New pages compare OpenUptime with other uptime tools and show how SaaS teams, agencies, online stores and DevOps teams set it up.",
      zh: "新增页面把 OpenUptime 与其他可用性监控工具做对比，并介绍 SaaS 团队、代理机构、电商和 DevOps 团队的配置方式。",
    },
    points: [
      { en: "Alternatives pages for UptimeRobot, Better Stack, Pingdom, StatusCake and Uptime Kuma list what OpenUptime has, what it lacks, who each tool suits and how to move monitors over with the JSON import.", zh: "UptimeRobot、Better Stack、Pingdom、StatusCake 和 Uptime Kuma 的对比页，列出 OpenUptime 有什么、缺什么、各自适合谁，以及如何用 JSON 导入迁移监控项。" },
      { en: "Use-case pages for SaaS, agencies, e-commerce and DevOps teams map concrete monitoring scenarios to monitor types, status pages and alert routing.", zh: "面向 SaaS、代理机构、电商和 DevOps 团队的使用场景页，把具体的监控场景对应到监控类型、状态页和告警路由。" },
    ],
    link: { href: "/alternatives", label: { en: "See the comparisons", zh: "查看对比" } },
  },
  {
    id: "incident-records",
    date: "2026-10-17",
    edition: "community",
    title: { en: "Richer incident records", zh: "更完整的事件记录" },
    summary: {
      en: "Incidents now have a number, a root cause and a postmortem, and each update can be kept internal.",
      zh: "事件现在有编号、根因和复盘，每条更新也可以设为仅内部可见。",
    },
    points: [
      { en: "Every incident gets a number that counts up inside its project (INC-12), shown in the list, on the incident page and in the API; search the list by number or title.", zh: "每个事件在所属项目内获得递增编号（如 INC-12），显示在列表、事件详情页和 API 中；列表可按编号或标题搜索。" },
      { en: "Write a root cause (up to 500 characters) and a postmortem (up to 20000) on the incident page or with PATCH /incidents/:id; both stay private until you publish them, and then appear on the public status page once the incident is resolved.", zh: "可在事件页或通过 PATCH /incidents/:id 填写根因（最多 500 字符）和复盘（最多 20000 字符）；两者在你发布之前保持私有，发布后于事件解决时显示在公开状态页上。" },
      { en: "Post an update as an internal note: it is visible to your team only and never reaches status pages, the RSS feed or subscriber emails. Updates stay public by default.", zh: "更新可以作为内部备注发布：仅团队可见，不会出现在状态页、RSS 订阅源或订阅者邮件中。更新默认仍为公开。" },
      { en: "The MCP tools gain an update_incident tool and a visibility option on create_incident and post_incident_update.", zh: "MCP 工具新增 update_incident，create_incident 与 post_incident_update 新增 visibility 选项。" },
    ],
    link: { href: "/docs/api", label: { en: "Read the API docs", zh: "阅读 API 文档" } },
  },
  {
    id: "push-critical-alerts",
    date: "2026-10-17",
    edition: "community",
    title: { en: "Critical push alerts and cleaner devices", zh: "紧急推送与设备清理" },
    summary: { en: "Phones can opt in to critical down alerts, and push notifications stay tidier.", zh: "手机可以选择接收紧急故障提醒，推送通知也更整洁。" },
    points: [
      { en: "Register a device with critical turned on and down alerts can break through Do Not Disturb; recoveries stay quiet.", zh: "注册设备时开启 critical，故障提醒即可突破勿扰模式，恢复通知仍保持安静。" },
      { en: "Down alerts without the opt-in are now marked time-sensitive, and reminders for one incident replace the earlier banner.", zh: "未开启时，故障提醒会标记为 time-sensitive，同一事件的提醒会替换之前的横幅。" },
      { en: "Devices that have not registered for 180 days are removed automatically.", zh: "180 天未重新注册的设备会被自动移除。" },
    ],
    link: { href: "/docs/api#push", label: { en: "Read the push API docs", zh: "阅读推送接口文档" } },
  },
  {
    id: "backup-restore-docs",
    date: "2026-10-17",
    edition: "community",
    title: { en: "Backup and restore guide", zh: "备份与恢复指南" },
    summary: {
      en: "A new docs page explains how to back up and restore the database of a Docker deployment.",
      zh: "新的文档页说明如何备份和恢复 Docker 部署的数据库。",
    },
    points: [
      { en: "Back up with pg_dump in the compressed custom format, then try the dump on a scratch database before relying on it.", zh: "用 pg_dump 的压缩 custom 格式备份，并先在临时数据库里试恢复，确认可用。" },
      { en: "The restore steps stop the app, take a safety dump, restore with pg_restore and start the app again; a section covers moving to a new server.", zh: "恢复步骤依次为停止应用、先做一份安全备份、用 pg_restore 恢复、再启动应用；另有一节说明如何迁到新服务器。" },
    ],
    link: { href: "/docs/backup", label: { en: "Read the backup guide", zh: "阅读备份指南" } },
  },
  {
    id: "quieter-incidents",
    date: "2026-10-17",
    edition: "community",
    title: { en: "Fewer noisy incidents", zh: "减少噪音事件" },
    summary: {
      en: "Monitors can now depend on each other, wait for several regions to agree, and reopen a just-resolved incident instead of opening a second one.",
      zh: "监控项现在可以相互依赖、等待多个区域一致失败，并在刚恢复又失败时重新打开原事件，而不是新建事件。",
    },
    points: [
      { en: "A monitor can depend on another monitor of the same project: while that one is down, this one still records its status but opens no incident and sends no alert.", zh: "监控项可以依赖同一项目中的另一个监控项：被依赖的监控项故障期间，它仍会记录自己的状态，但不会创建事件，也不会发送告警。" },
      { en: "With several regions, choose how many must fail before a monitor goes down; the number never exceeds the regions that answered, so a region that is itself down cannot block an alert.", zh: "使用多个区域时，可以选择需要多少个区域失败才判定为故障；该数量不会超过实际应答的区域数，因此某个区域自身故障不会阻止告警。" },
      { en: "A failure within 10 minutes of an outage resolving reopens that incident instead of opening a second one, unless a person resolved it.", zh: "故障恢复后 10 分钟内再次失败，会重新打开原来的事件，而不是创建新事件（人工解决的事件除外）。" },
      { en: "Slow-response incidents are no longer opened during a maintenance window.", zh: "维护窗口期间不再创建响应变慢的事件。" },
      { en: "Automatic incidents now show why they opened, for example how many regions failed.", zh: "自动创建的事件现在会显示创建原因，例如有几个区域失败。" },
    ],
    link: { href: "/docs/regions", label: { en: "Read the multi-region docs", zh: "阅读多区域检测文档" } },
  },
  {
    id: "target-address-pinning",
    date: "2026-10-17",
    edition: "community",
    title: { en: "Safer checks against private addresses", zh: "更安全的内网地址防护" },
    summary: {
      en: "A check now connects to the exact address that was verified as public, so a hostname cannot switch to an internal address in between.",
      zh: "检测现在会连接到已验证为公网的那个地址，主机名无法在验证之后改指向内网地址。",
    },
    points: [
      { en: "HTTP checks and webhook alerts connect to the verified address on every redirect hop, while the certificate is still checked against the hostname.", zh: "HTTP 检测和 Webhook 告警在每一次跳转时都连接到已验证的地址，证书仍然按主机名校验。" },
      { en: "A hostname that cannot be resolved is reported as unresolvable instead of being tried anyway.", zh: "无法解析的主机名会直接报告为无法解析，不再继续尝试连接。" },
      { en: "Keyword checks read at most 1 MB of a response, and a Lark webhook reply is read up to 64 KB, so a huge response cannot be pulled in.", zh: "关键字检测最多读取响应的 1 MB,Lark Webhook 的回复最多读取 64 KB，过大的响应不会被完整下载。" },
      { en: "Private addresses are still refused by default; ALLOW_PRIVATE_TARGETS=true keeps working as before.", zh: "默认仍然拒绝私有地址；ALLOW_PRIVATE_TARGETS=true 的行为不变。" },
    ],
  },
  {
    id: "prober-self-check",
    date: "2026-10-17",
    edition: "community",
    title: { en: "No false outages when the checker is offline", zh: "检测端断网时不再误报故障" },
    summary: {
      en: "When a check fails to connect, OpenUptime first makes sure the machine running it can reach the internet, and discards the result if it cannot.",
      zh: "检测连接失败时，OpenUptime 会先确认执行检测的机器自身能上网；如果不能，就丢弃这次结果。",
    },
    points: [
      { en: "A network failure on the checker's side no longer counts as a failed check, opens an incident or sends an alert.", zh: "检测端自身的网络故障不再计为失败检测，也不会创建事件或发送告警。" },
      { en: "A region whose probe is offline is left out of the run instead of voting the monitor down.", zh: "探测节点自身离线时，该区域不再参与判定，也不会把监控项判为故障。" },
      { en: "Errors that only the checker's own network can cause, such as a missing IPv6 route, are no longer blamed on your service.", zh: "只可能由检测端自身网络引起的错误（例如没有 IPv6 路由）不会再被算作你的服务故障。" },
      { en: "Monitors on private addresses, including names that resolve to one, are not affected, since they do not depend on the public internet.", zh: "监控内网地址（包括解析到内网地址的域名）的监控项不受影响，因为它们不依赖公网。" },
    ],
  },
  {
    id: "reliable-alert-delivery",
    date: "2026-10-17",
    edition: "community",
    title: { en: "Reliable, explained alert delivery", zh: "更可靠、可追溯的告警送达" },
    summary: {
      en: "Each alert is sent exactly once, every skipped or failed one says why, and unanswered incidents can repeat and escalate.",
      zh: "每条告警只会发送一次，被跳过或失败的告警会写明原因，无人响应的事件还可以重复提醒并逐级升级。",
    },
    points: [
      { en: "Two servers can no longer send the same alert twice, and alerts left half-sent after a crash are retried or marked failed.", zh: "两台服务器不会再重复发送同一条告警；因崩溃而卡在发送中的告警会被重试或标记为失败。" },
      { en: "An incident page now lists every notification with its status and, when it was skipped or failed, the reason.", zh: "事件页面现在列出每条通知及其状态；被跳过或失败时会显示原因。" },
      { en: "Repeat an unacknowledged alert every 5, 10, 15, 30 or 60 minutes, up to 10 times, to the mobile app and optionally email; if several repeats were missed only the latest is sent.", zh: "未确认的告警可每 5、10、15、30 或 60 分钟重复一次（最多 10 次），发送到手机 App，也可选择同时发邮件；错过多次时只发送最近一次。" },
      { en: "Set up to 3 escalation levels per project: if nobody acknowledges the incident after the delay, the next channels are notified. Acknowledging or resolving stops both.", zh: "每个项目最多设置 3 级升级：超过延迟仍无人确认事件时，通知下一级渠道。确认或解决事件后，重复与升级都会停止。" },
    ],
  },
  {
    id: "public-status-mcp",
    date: "2026-10-17",
    edition: "community",
    title: { en: "Read status pages from AI agents", zh: "AI 智能体可读取状态页" },
    summary: {
      en: "A public MCP endpoint lets an agent read a status page by its slug without signing in.",
      zh: "公开的 MCP 端点让 AI 智能体无需登录即可按 slug 读取状态页。",
    },
    points: [
      { en: "Three read-only tools, status_page_overview, status_page_incidents and status_page_maintenance, are served at /api/mcp/public; the existing tools still require authorization.", zh: "三个只读工具 status_page_overview、status_page_incidents 和 status_page_maintenance 在 /api/mcp/public 提供；原有工具仍需授权。" },
      { en: "Each page has a short llms.txt, and /.well-known/mcp.json lists the MCP endpoints.", zh: "每个状态页都有一份简短的 llms.txt,/.well-known/mcp.json 列出 MCP 端点。" },
      { en: "A page owner can switch the MCP tools off per page with “Allow the public MCP tools to read this page”; the page, its feeds and llms.txt stay public.", zh: "页面所有者可以用“允许公开的 MCP 工具读取此页面”按页关闭 MCP 工具；页面、订阅源和 llms.txt 仍然公开。" },
      { en: "The MCP docs now start with the one-line claude mcp add command.", zh: "MCP 文档现在以一行 claude mcp add 命令开头。" },
    ],
    link: { href: "/docs/mcp#public", label: { en: "Read the MCP docs", zh: "阅读 MCP 文档" } },
  },
  {
    id: "monthly-uptime-report",
    date: "2026-10-17",
    edition: "community",
    title: { en: "Monthly uptime report by email", zh: "月度可用率邮件报告" },
    summary: {
      en: "Workspace owners can opt in to an email with last month's uptime for every monitor.",
      zh: "工作区所有者可以选择接收邮件，查看上个月每个监控项的可用率。",
    },
    points: [
      { en: "Turn it on under Settings → Monthly report; it is off by default and sent once per month in the first days of the month.", zh: "在“设置 → 月度报告”中开启；默认关闭，每月初发送一次。" },
      { en: "The report lists uptime, downtime minutes and the number of incidents per monitor.", zh: "报告列出每个监控项的可用率、停机分钟数和事件数量。" },
    ],
    cloud: { en: "The report email counts toward the plan's monthly email allowance.", zh: "报告邮件计入套餐的每月邮件额度。" },
  },
  {
    id: "maintenance-reminders",
    date: "2026-10-17",
    edition: "community",
    title: { en: "Maintenance calendar and reminders", zh: "维护日历与提醒" },
    summary: {
      en: "Scheduled maintenance can be followed in a calendar app, and subscribers get a reminder before it starts.",
      zh: "可以在日历应用中订阅计划维护，订阅者会在维护开始前收到提醒。",
    },
    points: [
      { en: "Every status page serves its maintenance windows as an iCalendar feed at maintenance.ics.", zh: "每个状态页都以 maintenance.ics 提供维护窗口的 iCalendar 订阅源。" },
      { en: "Confirmed subscribers get one email before a window starts, 24 hours by default; set the lead time from 0 to 168 hours in the status page editor, where 0 turns it off.", zh: "已确认的订阅者会在维护窗口开始前收到一封邮件，默认提前 24 小时；可在状态页编辑界面设置 0 到 168 小时，0 表示关闭。" },
    ],
    cloud: { en: "Reminder emails count toward the plan's monthly email allowance.", zh: "提醒邮件计入套餐的每月邮件额度。" },
    link: { href: "/docs/embed#feeds", label: { en: "Read about feeds and the calendar", zh: "阅读订阅源与日历文档" } },
  },
  {
    id: "status-page-uptime-colors",
    date: "2026-10-17",
    edition: "community",
    title: { en: "Choose the uptime bar colors", zh: "自定义可用率条颜色" },
    summary: {
      en: "Each status page can set where its daily uptime bars turn amber and red.",
      zh: "每个状态页都可以设置每日可用率条何时变为琥珀色和红色。",
    },
    points: [
      { en: "Set two thresholds under Uptime and notifications in the editor; the defaults are 99.9% for green and 98% for amber.", zh: "在编辑界面的“可用率与通知”中设置两个阈值，默认绿色 99.9%、琥珀色 98%。" },
      { en: "The amber value must be lower than the green one.", zh: "琥珀色阈值必须低于绿色阈值。" },
    ],
  },
  {
    id: "status-page-feeds-subscribers",
    date: "2026-10-17",
    edition: "community",
    title: { en: "Better feeds and subscriptions", zh: "更好的订阅源与订阅" },
    summary: {
      en: "Status pages get a combined RSS feed and an embeddable Markdown badge, and subscribers get more control.",
      zh: "状态页新增合并的 RSS 订阅源和可嵌入的 Markdown 徽章，订阅者拥有更多控制。",
    },
    points: [
      { en: "rss.xml lists the latest 50 incidents and maintenance windows, and the status page links to it so feed readers find it.", zh: "rss.xml 列出最近 50 条事件和维护窗口，状态页中带有它的链接，RSS 阅读器可自动发现。" },
      { en: "The editor's Embed card adds a Markdown badge snippet and the feed and calendar addresses.", zh: "编辑界面的“嵌入”卡片新增 Markdown 徽章代码，以及订阅源和日历地址。" },
      { en: "Visitors can subscribe to only the components they care about.", zh: "访客可以只订阅关心的组件。" },
      { en: "Entering an address again sends a fresh confirmation or unsubscribe link, so an expired or lost link can be replaced.", zh: "再次输入邮箱会重新发送确认或退订链接，过期或丢失的链接可以补发。" },
    ],
    link: { href: "/docs/embed", label: { en: "Read the embed docs", zh: "阅读嵌入文档" } },
  },
  {
    id: "docker-scheduler-watchdog",
    date: "2026-10-17",
    edition: "community",
    title: { en: "Self-hosted restarts a stuck scheduler", zh: "自托管调度卡死时自动重启" },
    summary: {
      en: "A self-hosted container now restarts itself if the check scheduler hangs, instead of silently stopping checks.",
      zh: "自托管容器在检测调度卡死时会自动重启，不再悄悄停止检测。",
    },
    points: [
      { en: "If one scheduling round runs for more than five minutes, for example on a hung database call, the process exits and Docker's restart policy starts it again.", zh: "如果某一轮调度运行超过五分钟（例如数据库调用卡住），进程会退出，由 Docker 的重启策略重新拉起。" },
      { en: "Rounds that fail quickly, such as during a database outage, are unaffected and retry on the next round.", zh: "快速失败的调度（例如数据库故障期间）不受影响，下一轮会重试。" },
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
