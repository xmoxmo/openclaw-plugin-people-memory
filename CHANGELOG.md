# Changelog

## 0.0.1 — 首个发布（2026-10-31）

- 识人插件首个公开发布：按 agent 可见工作区隔离的 SQLite 识人 / 群记忆，插件 id `people`，包名 `openclaw-plugin-people-memory`。
- 数据目录默认 `<stateDir>/plugins/people/<workspace-key>/people.db`（`stateDir` 默认 `~/.openclaw`，可用 `OPENCLAW_STATE_DIR` 覆盖），与 bncr 的 `<stateDir>/plugins/<id>` 布局一致；可用 `dataDir: "{workspace}/people"` 留在工作区。
- 适用范围为通用入站元信息（发送者 id、昵称、群标题、是否群聊），全频道可用；BNCR 的同族归并只针对 GewePlus/GolemPlus 同 senderid 场景。
- 三层键模型（频道 / 平台 / 账号），同族人物自动归并；账号级与人物级两个维度，群级记忆独立记录。
- 内置识人技能 `skills/people-identifier`，随插件声明加载；提供周期维护任务模板 `automation/cycle.template.md` 与注册说明。
- 插件化维护周期 `people_cycle`：按需备份、自动修复安全项、健康检查并生成待办；repair 自愈孤儿群成员、缺显示名、空人物。
- 发布资料：`assets/icon.png`（1024×1024）、LICENSE、CHANGELOG，补齐 repository/homepage/bugs/keywords/engines/publishConfig。
