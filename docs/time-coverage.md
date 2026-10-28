# Monitor time coverage / 监控时间覆盖

The monitor detail page can load and export a 7- or 30-day report. The same authenticated report is available at `GET /api/monitors/:id/time-coverage?days=7` and through the MCP tool `get_monitor_time_coverage`. Workspace membership and API-key/OAuth project restrictions apply exactly as for reading the monitor.

监控详情页可以加载并导出 7 天或 30 天报告。API 为 `GET /api/monitors/:id/time-coverage?days=7`，MCP 工具为 `get_monitor_time_coverage`。权限沿用监控读取规则，包括工作区成员资格及 API key/OAuth 的项目范围。

## Measurement policy / 统计口径

`bounded-observation-v1` reports **inferred time covered by fresh observations**, not physical outage duration, an SLA, or a count of successful requests. It uses the voted result of one completed check (not one row per region). Failure/recovery alert thresholds, manual incident resolution and dependency alert suppression do not change the observation. A failed check is `down`; a successful check is `degraded` when latency exceeds the threshold captured by that check's configuration, otherwise `up`.

The UTC window is `[from, to)`, ending when the report is requested. Each observation covers from its completion until the earliest of the next observation/control event and its expiry. Regular checks expire after **interval + timeout + 60 seconds**; the 60 seconds allow for the scheduler's minute cadence. Heartbeat observations expire after **interval + grace**. This freshness allowance is a stated inference policy, not evidence that the service stayed healthy between probes. Delayed/missing checks, exhausted hosted credits, inconclusive probes and periods before the feature was installed become `unknown` after the last valid observation expires. Nothing backfills old history from rollups or incidents.

`bounded-observation-v1` 表示**有效期内观测所覆盖的推断时间**，不是精确停机时长、SLA 或成功请求数。多区域检测只记录投票后的一个结果。告警失败/恢复阈值、手工解决事故及依赖告警抑制不改变观测结果：失败为 `down`，成功但延迟超过当次配置阈值为 `degraded`，其他成功为 `up`。

UTC 时间窗为请求时刻结束的 `[from, to)`。一次观测从检测完成起覆盖到下一次观测/控制事件或有效期结束（取较早者）。普通检测的有效期是**检测间隔 + 超时时间 + 60 秒**，最后 60 秒是分钟级调度容差；心跳有效期为**间隔 + 宽限期**。这是一条公开的推断规则，不能证明两次检测之间服务一直正常。延迟、缺失检测、托管额度用尽、探针无法判断及功能安装前的历史，在最后观测到期后均为 `unknown`。不使用历史汇总或事故记录回填。

## State and maintenance / 状态与维护

The report returns milliseconds for `up`, `down`, `degraded`, `paused` and `unknown`; these sum to `totalMs`. Pause is recorded from the configuration change until resume, independently of any in-flight check. Resume and other configuration edits invalidate previous coverage and start unknown time until a fresh check. Existing paused monitors have unknown history until a pause/control event is recorded. Freshness does not carry across changed configuration. The report intentionally does not combine degraded, paused or unknown time into a percentage.

Maintenance is **included**. `observedMaintenanceMs` is an overlapping label: observations captured while a maintenance window was active retain its then-known end time. A window starting between checks is not retroactively reconstructed, and later editing/deleting a window does not rewrite the recorded label. This is not an exact maintenance occurrence ledger and must not be subtracted from the denominator. Precise maintenance exclusion needs a separate occurrence history.

各状态返回毫秒数，总和等于 `totalMs`。暂停从配置变更开始记录，持续到恢复，不受正在执行的检测影响。恢复及其他配置编辑会使旧观测失效，在新检测到来前计为未知。原本已暂停的监控，在记录控制事件前的历史仍为未知。报告不将缓慢、暂停或未知时间合成为一个可用率。

统计**包含维护**。`observedMaintenanceMs` 是与状态重叠的标记，保存检测发生时已生效维护窗口的当时结束时间。不会回推两次检测之间开始的维护；后续修改或删除维护也不会重写已保存标记。它不是精确的维护执行记录，不能直接从分母扣除。精确排除维护需要独立的执行历史。

## Storage and concurrency / 存储与并发

Observation append and generation updates lock the monitor in one transaction. Configuration changes increment a revision and append a control event in one transaction. Old configuration results and duplicate/older scheduled generations are discarded. A heartbeat that wins a race with a missed-heartbeat check prevents the stale miss from adding coverage. Manual checks may create fresh observations; unrecorded regional spot checks do not.

Observations are kept for 35 days plus the latest older event per monitor as a boundary anchor. Expired observations never extend through missing data; the retained predecessor also prevents an old pause from reappearing after a resume is purged. Monitor/workspace deletion cascades to this history. Storage grows with check frequency (one row per recorded run); aggregate queries run inside PostgreSQL rather than loading a month's observations into an API worker. Raw-check retention does not control this separate 35-day history.

写入观测与检测序号更新在同一事务内锁定监控；修改配置与增加版本号、写入控制事件也在同一事务内完成。旧配置结果、重复或过时的调度序号被拒绝。心跳先于缺失判断写入时，过时的缺失观测不会进入历史。手动完整检测可以产生新观测；单区域临时测试不会。

保留 35 天观测及每个监控最后一条更早的事件作为时间窗边界锚点。过期观测不会延续到缺失区间；保留最后事件也避免删除恢复事件后旧暂停重新生效。删除监控/工作区时级联删除历史。存储量与检测频率成正比（每次记录的检测一行）；统计由 PostgreSQL 聚合，避免 API Worker 读取整月明细。原始检测保留设置不影响这份独立的 35 天历史。
