# Changelog

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
