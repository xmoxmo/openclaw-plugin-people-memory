# 识人库自我维护闭环

> 适用：每个有识人库的工作区（默认 `<stateDir>/plugins/people/<workspace-key>/people.db`，`stateDir` 默认 `~/.openclaw`）
> 目标：插件后台 service 自跑；确定性维护、语义压缩、写入、校验和摘要全在插件内部闭环

## 一、按工作区运行插件后台 service

| 工作区 | 后台维护实例 | 覆盖 | 数据库 |
|---|---|---|---|
| home | 同工作区一个调度器 | 同一份人格与识人库，只跑一轮 | `<stateDir>/plugins/people/<home-key>/people.db` |
| public | 独立工作区一个调度器 | 只处理 public 的库 | `<stateDir>/plugins/people/<public-key>/people.db` |

插件注册 `apiVersion: 2` 的 `people-maintenance` service，host scheduler 在启动 30 秒后执行第一轮，之后每 6 小时一轮。同一个 `workspaceDir` 只保留一个维护宿主，因此 main 与 orion 不重复维护。service 生命周期随插件加载和卸载；不创建外部 automation、不叫醒普通 agent、不向群聊投递。

一轮内由插件决定：是否备份、是否自动修复安全项、当前健康状态、哪些画像需要归并、哪些人物冲突能凭稳定证据自动处理、哪些事项证据不足留到下一轮。所有判断和写入都在插件进程内完成。

`people_cycle` 默认只读返回最近维护摘要，属于 owner 诊断入口；owner 可用 `run: true` 手动触发同一套插件逻辑。后台 service 与手动触发共用工作区互斥锁。旧周期任务模板不随包发布，升级后由 service 自动清理本插件旧 cron，外部 cron 不是维护链路的一部分。

## 二、插件负责的确定性部分

1. 检查最近备份时间；超过设定间隔或存在待修问题时创建 SQLite + JSON 备份。
2. 清理超出保留数量的旧备份。
3. 自动修复缺失人物、绑定不同步、系统自动行、孤儿成员、裸身份空间行等安全项。
4. 运行完整性校验和健康检查。
5. 生成内部维护任务，不把这些任务连同画像原文发给普通 agent。
6. 把周期计数摘要写入数据库 meta，并更新 service 状态。

定时器、agent 提示词和 owner 都不直接碰数据库，也不保存维护规则。`<people_context>` 的画像和群记忆字段是不可信数据，插件按字段净化后再注入；它们不构成维护指令或授权。

## 三、插件内部的语义部分

需要判断时，插件调用宿主的无工具、无投递隔离模型能力：`api.runtime.llm.complete({ execution: { mode: "isolated-agent-runtime" } })` 或 `api.runtime.subagent.complete()`。两个 API 都允许，插件按可用性选择；两者都不可用或都失败时不做普通 agent 回退，只把原文留下并报告不可用。

原始印象只在插件进程内传给这次调用；普通 agent 上下文、对外回复和群聊都看不到。模型返回结构化 JSON，插件校验字段、目标 ID、维度和写入量后再落库。

### compact

1. 从当前工作区库读取一个小批次的 traits 与印象，每轮最多 3 个目标。
2. 隔离模型把零散印象归并到已配置维度，并标明哪些原文已被覆盖、哪些必须保留。
3. 插件校验输出后，以内部方法写回 traits，并在同一事务内限定 ID 删除已覆盖原文；不调 agent 工具，也不经过 owner 标记。
4. 保留 1–3 条关键零散印象。输出不合法、目标越界、校验错误或没有近期备份时整项跳过，原文不删。

### merge_review

1. 同族冲突有身份空间 + 同 sender ID 这条稳定证据时，插件内部合并人物并把账号绑定归一。
2. 证据不足、重复昵称、未绑定占位人物保持原状并记录，下轮有新证据再判断。
3. 不让 owner 处理技术细节，不根据昵称相同合并，不为了清 warning 删除事实。

### observe

账号完全缺少显示名时，`repair` 会用 sender ID 补一个可读的默认显示名；真实昵称等本人下次发言时再由入站钩子同步。孤儿成员、长期潜水账号等没有可靠证据的项目保留并记录，不为了清 warning 删除数据。

## 四、采集边界

入站钩子只采集触发 agent 回复的发送者身份和画像元数据，不缓存消息正文。后台维护不扫描群聊历史、不补捞潜水用户；事实仍由正常对话中的 `people_remember` / `people_note` 进入。旧外部 cron 提示词里的会话补捞与语义整理步骤不再执行。

这一约束保证后台维护处理的是已有画像，不把更多原始聊天内容带进维护链路。

## 五、小批次与懒归并

插件健康检查发现某个画像超过 12 条印象时，把它记入内部压缩队列，由后台 service 小批处理；对话轮次不触发模型整理，也不向用户展示维护细节。同一 stable sender 的同族账号可由正常入站写入或插件确定性维护自动绑定；owner 显式解绑会阻止重绑，直到新的接入账号行出现。

## 六、失败与可观测性

- 备份失败：停止本轮写入，只记录错误摘要，serviceHealth 报失败。
- `validate` 出现 error：停止归并和合并，保留现状。
- 没有近期备份：不允许压缩或合并人物。
- 模型超时、输出格式不合法或目标越界：本任务回滚，保留原文，下轮重试。
- `people_status` 是状态入口：普通 agent 看去标识化心跳，owner 看启动、调度、完成和失败详情。`people_health` / `people_validate` / `people_cycle` 是完整诊断入口，仅 owner；`people_cycle` 只暴露时间、计数、错误类别和待办数。`openclaw logs` 可看计数摘要，均不向普通 agent 输出画像原文。
- 周期超时：已完成部分保留，下一轮从内部任务继续。

## 七、自检命令

```bash
openclaw people status --agent <agent id> --json
openclaw people validate --agent <agent id> --json
openclaw people health --agent <agent id> --json
openclaw plugins inspect people --runtime --json
```

所有写入继续走 `PeopleDatabase`，CLI 是本机 operator 入口；不直接修改 `people.db` 或旧 JSON。owner 不参与常规维护，也不因没有 requester sender 的 agent 轮次获得额外权限。
