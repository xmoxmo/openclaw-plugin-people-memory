# Changelog

## 0.0.6 — 稳定身份、宿主 owner 授权与内部自维护（2026-11-09）

- 稳定身份改为「频道身份空间 + 用户 / 群 ID」：普通频道用频道名整体，BNCR 用 `bncr/后端` 整体；宿主 `accountId` / `Primary` 不再参与身份。入站优先读宿主标准字段，BNCR 标准字段缺后端时才回退解析 sessionKey 的 hex 段。
- owner 授权只认宿主本轮 `senderIsOwner=true`；inbound_claim 按「工作区 + sessionKey + senderId」单次绑定、消费即删。删除 `internalAdminAgents` 与「无发送者即内部管理员」的插件自造授权链。
- 注册插件后台 `people-maintenance` service：按工作区用宿主 scheduler 定时执行确定性维护、内部隔离 completion 画像压缩、内部写回和计数摘要；`runtime.llm.complete` 与 `runtime.subagent.complete` 均支持，不做普通 agent 回退。
- `people_cycle` 默认改为只读维护摘要；owner 可用 `run: true` 手动触发同一套插件内部逻辑。后台维护不再通过 agent 工具提权。
- 清理现有 `people-cycle-home` / `people-cycle-public` 外部 cron；旧周期提示词标记为历史参考，不随新流程运行。
- 旧定时任务模板不再随包发布；`people-maintenance` service 启动时按已知名称与插件证据自动清理旧周期 cron，并保留手工只读核对入口。
- agent 工具固定绑定当前会话 agent 的工作区，拒绝 `workspace` 参数切库；CLI operator 的 `--workspace` 保留。owner 权限以当前会话 agent 范围为界，不跨 agent 授权。
- 状态和诊断分成两个入口：普通 agent 可用 `people_status` 看去标识化运行状态并查自己画像；`people_health` / `people_validate` / `people_cycle` 只向 owner 返回完整诊断，owner 可在 `people_status` 看详细计数与路径。
- 修复 owner claim 在重复 hook 事件后的单次消费语义：只有宿主 `inbound_claim` 的新一轮 owner 标记可重建 claim，消费即删，不靠轮次缓存跨轮续权。
- 后台维护状态与最近维护摘要写入工作区数据库 meta，CLI 和 Gateway 进程可以看到同一份心跳；同族证据合并增加 24 小时内备份门槛。
- 同族人物绑定冲突在稳定身份证据充分时由插件内部合并；重复昵称与未绑定占位人物保持原状。
- `people_status` 增加后台 service 启动、调度、完成与失败心跳；完整 health / validate 诊断仅 owner。
- 文档与技能统一到新边界；补齐鉴权、后台 service、插件内部压缩、身份空间与 owner claim 回归测试。

## 0.0.5 — 隔离与写开关修复（2026-11-02）

- 修复多个 `senderFamilies` 含同一 sender 时被拼接为一个身份的问题。每个 family 现在独立归并，跨 family 不会共享人物、特征或印象。
- `people_merge_account` 纳入 `writeTools=false` 的写工具门禁，关闭写入后不能再通过账号归并修改数据。
- 非 owner 的内部维护身份不能再用 `workspace` 参数打开其他工作区；带工作区参数的管理工具统一执行所有者校验。
- Unicode 与反斜杠工作区路径增加摘要后缀，避免不同路径映射到同一个默认数据库目录；既有纯 ASCII 工作区目录名保持不变。
- 新增跨 family、跨工作区、写工具清单和路径碰撞回归测试。

## 0.0.4 — 安全边界与严格模式（2026-11-02）

- 新增严格模式 `internalAdminAgents`：默认不设置时保持原有行为（无发送者的内部任务视为维护身份）；设置后只允许名单内 agent 作为内部管理员。用于收紧 cron / heartbeat / subagent 与公开入口共用「无 requesterSenderId」带来的提权面。
- 新增 `writeTools` 开关（默认 `true`）：独立控制写类工具。`capture` 仍只控制自动采集，关闭它不会再被误解为禁止工具写入；需要禁止写入时显式设 `writeTools: false`。
- `people_forget` 新增 `purge` 选项（默认关闭）：显式彻底清除时同时删除备份快照和旧 JSON 归档，避免删除后历史数据仍留在 backups / legacy 文件中。不可恢复，需显式传 `purge: true`。
- 权限一致性：非 owner 只能查询/写入当前群的群记忆；`purge`、`people_status`、`people_health`、`people_backup`、`people_bootstrap`、`people_scan_mark` 统一要求 owner 或内部维护身份。
- `people_status` 与 `openclaw people status` 显示当前安全模式，未启用严格模式时提示可启用。
- 文档补充安全边界：哪些问题属于设计取舍（同意流程、群成员校验、定时采集批准、宿主机权限、社区频道），以及默认行为为何保持不变。
- 新增鉴权、配置归一化与 purge 的回归测试。

## 0.0.3 — 发布链路验证（2026-11-01）

- 验证 GitHub Actions OIDC 自动发布链路（tag → npm publish --provenance）；无功能变更。

## 0.0.2 — 修复版（2026-10-31）

- 隐私修复：移除代码注释中残留的真实账号/群 ID 示例。
- 工作区隔离修复：目录键先转义下划线，`/a/b` 与 `/a__b` 不再映射到同一数据库；现有无下划线路径目录名不变，无需迁移。
- 鉴权收紧：发送者存在但身份解析失败时，非 owner 不再可查询/修改他人画像。
- 数据安全：`repair` 前若未到周期备份会先补一次备份；合并账号/人物时同维度冲突特征保留为印象，不再静默丢弃。
- 新增工作区键碰撞、合并保留特征的回归测试。

## 0.0.1 — 首个发布（2026-10-31）

- 识人插件首个公开发布：按 agent 可见工作区隔离的 SQLite 识人 / 群记忆，插件 id `people`，包名 `openclaw-plugin-people-memory`。
- 数据目录默认 `<stateDir>/plugins/people/<workspace-key>/people.db`（`stateDir` 默认 `~/.openclaw`，可用 `OPENCLAW_STATE_DIR` 覆盖），与 bncr 的 `<stateDir>/plugins/<id>` 布局一致；可用 `dataDir: "{workspace}/people"` 留在工作区。
- 适用范围为通用入站元信息（发送者 id、昵称、群标题、是否群聊），全频道可用；BNCR 的同族归并只针对 GewePlus/GolemPlus 同 senderid 场景。
- 三层键模型（频道 / 平台 / 账号），同族人物自动归并；账号级与人物级两个维度，群级记忆独立记录。
- 内置识人技能 `skills/people-identifier`，随插件声明加载；提供周期维护任务模板 `automation/cycle.template.md` 与注册说明。
- 插件化维护周期 `people_cycle`：按需备份、自动修复安全项、健康检查并生成待办；repair 自愈孤儿群成员、缺显示名、空人物。
- 发布资料：`assets/icon.png`（1024×1024）、LICENSE、CHANGELOG，补齐 repository/homepage/bugs/keywords/engines/publishConfig。
