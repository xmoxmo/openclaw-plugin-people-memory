# Changelog

## 0.0.8 — 身份、授权与维护加固（2026-11-10）

- 新增账号级 `bot_hint=unknown|human|bot|mixed` 与 `bot_hint_source=history|group_evidence|manual`；它是根据历史行为作出的、可能误判的软提示，不影响身份、owner 授权、绑定、归并或回复硬门禁。`mixed` 表示人与 bot 可能共用账号。
- 自动 bot 证据只填写 `unknown`，不覆盖人工 `human/bot/mixed`；owner 可新增 `people_bot_hint` 修正。旧 `current_role` 仅保留 owner 等兼容角色，不再承载 bot 判断。
- schema 升到 v3，v1/v2 旧库自动新增 hint 列并迁移旧角色；账号归并时 `bot` 与 `human` 合成 `mixed`。`<people_context>` 对已知 hint 只增加一条标量参考行，`unknown` 不增加；画像卡和详情标注“仅供参考”。群观察表继续作为旧 JSON 兼容归档，不默认注入 prompt。
- owner 授权只接受宿主本轮标准字段：工具执行上下文的 `senderIsOwner`，或 `before_tool_call` 的 `requester.senderIsOwner` 按精确 `toolCallId` 形成的一次性 receipt；删除 inbound claim 和跨轮缓存。
- 非 owner 的群读写必须匹配完整频道身份空间和 chat ID；deferred、裸 BNCR、缺 chat ID 以及同群号跨后端碰撞均 fail closed，纯数字群号优先解析当前身份空间。
- `<people_context>`、画像详情和全局搜索结果把昵称、备注、特征、印象、群标题与群事件作为不可信数据显示，移除控制字符、bidi / 零宽字符、伪造标签和跨行指令；画像压缩指令不再注入给 agent。
- 正常使用行为保持不变：自动采集与上下文注入继续默认开启，普通 agent 可查自己、写当前群和查看基础状态，宿主本次标记 owner 的调用仍可查他人、看诊断和手动维护。
- 身份缓存按 `workspace + session + run` 精确匹配；过期或跨 session 的 sender 不再回退成另一轮身份。
- 身份缓存支持仅有 `runId` 的宿主调用，并把并行 run 隔离到各自工作区绑定；只有 session 与 run 都缺失时才使用 sender + chat 的唯一精确回退。
- owner 孤儿成员修复只允许同平台或已配置 sender family 自动绑定；跨无关平台保持原状。
- 删除账号时在同一事务清理群成员；SQLite 与 JSON 备份严格来自同一快照，备份文件权限固定为 `0600`，已有数据目录尽力收紧为 `0700`。
- 修复账号/人物绑定双写不变量：检测 `accounts.bound_person_id` 与 `person_accounts` 的任一方向不一致，并在 repair 中双向收敛。
- 账号与群归并保留缺失名称、群标题、bot 名和完整首次/最近时间范围；旧 JSON 导入保留 `confirmed_name`，并归一旧 BNCR 桥接账号别名。
- 旧 JSON 账号画像的 `current_role` 作为富来源导入，并转换为 `bot_hint`；`owner` 不参与 bot 推断。缺少有效时间的旧 `scan-state` 不再清空数据库中已有的全量扫描进度。
- 旧 BNCR 群成员 ID 按群后端归一；裸账号有绑定或画像时不会被 repair 静默删除，按人物名绑定只接受唯一精确匹配。
- 语义压缩失败写入 service failure；旧快照不回退 `current_role`；空 agent entries 回退当前工作区；owner abort 后不进入 completion 回退。
- 后台维护对每个工作区隔离 scheduled/completion 心跳写入和 lease-release 异常，一个工作区失败不会中断其他工作区；忙锁跳过不伪造完成。
- hooks 与 runtime 统一解析宿主自定义 stateDir；维护摘要按解析后的时间值选择，不受时区偏移影响。
- 裸 BNCR 行只在唯一后端可确定，或全部后端兄弟属于同一 sender family 且无人物/角色冲突时迁移；跨独立后端不再按最近活跃时间猜目标。
- 周期备份识别 repair 与 compact 的实际变更面，包括没有 health warning 的同族归并、成员 owner 角色补标和系统成员清理，避免自动写入缺少回滚快照；既有账号仅补成员证据时也会留下修复动作。
- 宿主 scheduler 的取消信号贯穿当前维护周期；停止或重载时不会继续执行下一个工作区、画像压缩或写入假的完成心跳，后台 service 在同对象 `start → stop → start` 后恢复运行态引用。
- `people_cycle { run: true }` 现在消费宿主工具调用的取消信号；CLI `cycle` 同时把内部语义维护失败计为命令失败。
- 画像压缩 completion 返回后重新读取 owner、活跃维度、原印象与当前特征；等待期间的删除、账号归并或特征更新会阻止旧快照回写，新印象与其他维度保持不动。
- 隔离模型的画像压缩提示把原始印象和既有 traits 都显式标为不可信证据，内部模型不得执行其中的命令、授权声明或输出格式要求。
- 身份缓存中的 session→workspace 绑定增加 10 分钟 TTL 和 500 项上限，未命中的 prompt session 不会无限增长。
- 单次维护心跳 patch 改为同一 SQLite 事务，任一字段写入失败不会留下“已完成但摘要未写”等半套状态。
- BNCR 明确以标准 metadata 投递目标中的后端与 chat 为一致身份；session hex 只在 chat 坐标缺失时回退，且必须精确匹配本轮 session 段，避免正常 hex 形态 chat ID 被误判。
- 宿主省略 run/session 标识时，hooks 与工具只使用完整“工作区 + 频道 + sender + chat”精确关联；缺少 chat 仍 fail closed，不按 sender 单字段回退。
- 显式 `multiAccountChannels: []` 可关闭多账号频道默认值；空 platform / sender 在 service 和数据库边界拒绝写入。
- 数据库文件被删除或替换后，运行时关闭旧句柄、打开新文件并丢弃旧维护摘要；CLI `validate` / `health` / `cycle` 在检查失败时返回非零退出码。
- 增加账号绑定双向一致性修复、账群归并元数据保留、旧 BNCR 成员 ID 归一、备份权限、事务回滚、调度取消和 completion 并发回归；全部测试通过。

## 0.0.7 — 发布包完整性修复（2026-11-09）

- 发布仓同步补入新增的 `dist/src/plugin/{identity-store,legacy-cron,maintenance,service}.js`，修复 0.0.6 npm 包入口引用 `service.js` 但文件缺失的问题。
- 增加从 registry tarball 反查入口依赖与文件清单的门禁；源码、数据库、设计和行为不变。

## 0.0.6 — 稳定身份、宿主 owner 授权与内部自维护（2026-11-09）

- 稳定身份改为「频道身份空间 + 用户 / 群 ID」：普通频道用频道名整体，BNCR 用 `bncr/后端` 整体；宿主 `accountId` / `Primary` 不再参与身份。入站优先读宿主标准字段，BNCR 标准字段缺后端时才回退解析 sessionKey 的 hex 段。
- owner 授权只认宿主本轮 `senderIsOwner=true`。当时曾用 inbound claim 按「工作区 + sessionKey + senderId」单次绑定、消费即删；Unreleased 已删除 claim 路径，只保留工具调用 `requester.senderIsOwner` 的一次性 receipt，并删除 `internalAdminAgents` 与「无发送者即内部管理员」的插件自造授权链。
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
