# People Memory

OpenClaw 的识人插件。按 **agent 可见工作区** 隔离数据：同一个 `workspaceDir` 下的 agent 共用一套识人库，不同工作区互不可见。存储使用 SQLite，不再把 JSON 当主存储。

## 边界

```
<stateDir>/plugins/people/<workspace-key>/people.db   ← 每个工作区一份
```

- 默认数据目录是 `<stateDir>/plugins/people/<workspace-key>`。`stateDir` 默认 `~/.openclaw`，可用 `OPENCLAW_STATE_DIR` 覆盖；布局与 bncr 的 `<stateDir>/plugins/<id>` 一致。`<workspace-key>` 由工作区真实路径编码而来。
- 同一 `workspaceDir` 下的 agent 共用一份库；不同工作区互不可见。
- 想把数据放到别处（例如留在工作区），用 `dataDir` 或 `workspaceDataDirs` 覆盖；插件按 `realpath` 识别同一个库。

例如留在工作区：

```json
{
  "plugins": {
    "entries": {
      "people": {
        "config": {
          "dataDir": "{workspace}/people"
        }
      }
    }
  }
}
```

## 适用范围

- 插件读取的是**通用入站元信息**：发送者 id、显示昵称（`name / displayName / display_name / nickname / username`）、群标题（`title / subject / group_subject`）、是否群聊（`isGroup / type=group`）。任何能提供这些信息的频道都能用，没有平台绑定。
- 稳定身份是「频道身份空间 + 用户 ID / 群 ID」。普通频道的身份空间是频道名整体（如 `telegram`）；BNCR 带多个后端，身份空间是 `bncr/GewePlus`、`bncr/tgBot` 这类整体。宿主 `accountId` / `Primary` 是路由账号，不参与识人身份。
- BNCR 的两点只跟它的接入结构有关，不代表别的频道缺能力：
  - 同族自动归并只针对 GewePlus 与 GolemPlus——这两个后端 senderid 空间一致，同一 sender 才需要归到同一个人物。别的频道没有"同一人两条接入同 id"的情况，本来就不需要归并。
  - bot 识别靠群 botNames + `current_role=bot`，是通用逻辑，有群成员信息就能用。
- 频道不在 `channelContext` 里给昵称/群标题时，插件用 `inbound_claim` 从入站事件被动补录，仍能建档。

## 安装

```bash
cd <plugin-dir>
npm run build

openclaw plugins install --link <plugin-dir> --force --no-enable
```

在 `openclaw.json` 中授权对话钩子并启用：

```json
{
  "plugins": {
    "entries": {
      "people": {
        "enabled": true,
        "hooks": {
          "allowConversationAccess": true
        },
        "config": {
          "injectContext": true,
          "injectGroupMemory": true,
          "disabledAgents": []
        }
      }
    }
  }
}
```

`allowConversationAccess` 是 OpenClaw 对 `before_prompt_build` 这类对话钩子的授权项，必须放在 `hooks` 下，不能放在插件自己的 `config` 里。

**沙箱 agent 额外一步**：沙箱只能调用 `tools.sandbox.tools.alsoAllow` 里列出的工具。没加 `people_*` 时，模型会报 `Unknown tool id: people_status`。给每个沙箱 agent 加上：

```json
{
  "agents": {
    "entries": {
      "<agentId>": {
        "tools": {
          "sandbox": {
            "tools": {
              "alsoAllow": [
                "people_status", "people_lookup", "people_remember", "people_name", "people_note",
                "people_bind", "people_forget", "people_validate", "people_scan_mark", "people_bootstrap",
                "people_backup", "people_health", "people_cycle", "people_search", "people_dimension",
                "people_merge", "people_merge_account", "people_unbind"
              ]
            }
          }
        }
      }
    }
  }
}
```

非沙箱 agent 不需要这一步。public 已在 `openclaw.json` 中配置。

## 工具

| 工具 | 作用 | 权限 |
|---|---|---|
| `people_status` | 状态入口：是否正常运行、采集心跳、后台维护心跳。普通 agent 看去标识化状态，owner 看计数、路径和详细时间 | 所有 agent（详细仅 owner） |
| `people_lookup` | 查自己、指定账号/人物或群记忆；`account`、`person`、`query` 都可引用，`full: true` 返回完整 traits 和印象列表 | 查他人仅 owner |
| `people_remember` | 记一条事实/印象，可写入维度（key 或中文标签均可）；`person` 参数用于人物级画像 | 自己；owner 可指定他人/人物 |
| `people_name` | 设置 call_name / confirmed_name / 人物名 | 自己；owner 可指定他人 |
| `people_note` | 追加群记忆 | 当前群成员 |
| `people_bind` | 账号绑定到人物，合并画像 | owner |
| `people_forget` | 删除匹配的印象/特征；`scope` 限定范围；`purge: true` 同时清除备份与旧归档（不可恢复） | 自己；owner 可指定他人/人物 |
| `people_validate` | 诊断入口：一致性校验，可选修复 | 仅 owner |
| `people_scan_mark` | 记录显式扫描进度；后台维护不扫描会话历史 | owner |
| `people_bootstrap` | 初始化当前会话工作区识人库，导入旧 JSON | 仅 owner |
| `people_backup` | 生成当前会话工作区的 SQLite + JSON 备份并轮换旧备份 | 仅 owner |
| `people_health` | 诊断入口：重复人物、过密画像、孤儿记录、缺备份等完整报告 | 仅 owner |
| `people_cycle` | 诊断入口：只读查看后台维护摘要；owner 可用 `run: true` 手动触发一轮插件内部维护 | 仅 owner |
| `people_search` | 跨账号、人物、印象、群事件搜索 | owner |
| `people_dimension` | 查看、添加、启停画像维度 | 查看所有；修改仅 owner |
| `people_merge` | 合并重复人物 | owner，需 confirm |
| `people_merge_account` | 合并同一人物的双份账号，迁移印象、特征、群成员和绑定 | owner，需 confirm |
| `people_unbind` | 解绑账号并默认复制人物画像回账号 | owner，需 confirm |

账号引用可写规范 id（`bncr/GewePlus:wxid_x`），也可写 `bncr:GewePlus:wxid_x`。群引用支持完整 group_id、纯数字 chat_id，以及 `GewePlus:123456789` 这类带平台前缀的写法。owner 权限只认宿主当前轮次的 `senderIsOwner=true`；插件不设白名单、不按 sender ID / agent ID / cron 身份推断 owner、不缓存、不跨轮复用。`inbound_claim` 的单次 owner claim 消费即删，新一轮要重新由宿主给出。后台维护由插件内部调用完成，不通过 agent 工具提权；显式查询不要求当前发送者已有账号行。

状态与诊断是两个入口：普通 agent 用 `people_status` 看是否正常，也可查自己的画像；完整诊断（`people_health` / `people_validate` / `people_cycle`）只给 owner。agent 工具始终绑定当前会话 agent 的工作区，不接受 `workspace` 参数切换；要操作另一个工作区，就在该工作区有权限的 agent 会话中执行。CLI 的 `--workspace` 属于本机 operator 入口，由宿主文件系统权限约束。

## 自动行为

启用后，入站观察钩子会被动记录归一化的频道、后端、昵称、群标题和群聊标记（不存消息正文），供同一轮的 `before_prompt_build` 与 `people_*` 工具共用。`message_received` 是异步观察钩子；BNCR 后端仍以标准入站元数据为准，标准字段缺失时才用 hex 会话段回退。随后 `before_prompt_build` 在每轮对话前：

1. 从频道上下文解析平台、发送者、会话。
2. 首次见到账号时建档，更新 `display_name` 与 `last_interaction`。
3. 识别群会话时更新群标题与成员。
4. 注入一张 `<people_context>` 小卡片，包含当前对象画像和最近群记忆。

同一账号 30 秒内只写一次，避免重试和多轮调用造成写放大。任何异常都不会中断对话，只会记一条警告日志。

当某个画像的零散印象超过 12 条时，后台 service 在下一轮维护中用插件内部隔离模型压缩画像。注入卡片只给当前 agent 必要的提示，不把画像原文或维护计划交给普通 agent；owner 也不需要手动整理。

## 频道兼容

身份空间优先取宿主标准归一字段，不依赖 BNCR：

| 上下文 | 身份空间 | 账号 / 群 |
|---|---|
| `channel=bncr` + 入站 `Bncr:tgBot:<群>:0` | `bncr/tgBot` | `bncr/tgBot:<用户>` / `bncr:tgBot:<群>` |
| `channel=telegram` | `telegram` | `telegram:<用户>` / `telegram:<群>` |
| `channel=discord, accountId=work` | `discord` | `discord:<用户>` / `discord:<群>` |

BNCR 标准入站投递目标读不到后端时，才回退反解 `sessionKey` 的 hex 会话段；其他频道只用标准字段。发送者名、群标题、是否群聊都按候选字段读取，兼容 `name / displayName / display_name / nickname / username`、`title / subject / group_subject`、`isGroup / type=group` 等常见形态。特殊频道可用 `platformOverrides` 显式自定义身份空间。

## 从 JSON 迁移

首次打开一个工作区的库时，如果目录里存在旧 JSON，会自动导入一次：

- `accounts.json`（平铺或 `accounts` 包装）
- `accounts/**/*.json`
- `persons.json`、`persons/**/*.json`
- `person_accounts.json`
- `groups.json`（平铺或 `groups` 包装）
- `groups/**/*.json`（新旧两套命名会按 `platform + chat_id` 去重）
- `scan-state.json`（`channels` 数组或 dict）
- `trait-dimensions.json`

账号与人物上的 `call_name`（本人钦定称呼）会一并导入，优先级高于 `confirmed_name` 和平台昵称。

导入后：

- 旧 JSON 保留为只读归档，不删除、不再写入。
- `people.db` 成为唯一主存储。
- 导入标记写在 `meta.legacy_imported_at`。

迁移期间必须先停掉旧的 JSON 写入链路（旧扫描任务、手工脚本），否则会出现两套数据分叉。

已经导入过、但之后补了字段或要重跑时，用强制导入（按去重键合并，不会重复写印象）：

```bash
openclaw people import --workspace <workspace> --force
```

## CLI

```bash
openclaw people status   --workspace <workspace>
openclaw people validate --workspace <workspace> --json
openclaw people bootstrap --workspace <workspace>/public
openclaw people import --workspace <workspace>/public --force
openclaw people validate --workspace <workspace> --fix
```

CLI 可以带 `--workspace` 选择本机工作区；这是 operator 命令，不等同于 agent 工具权限。

## 开发

```bash
npm run build
npm test
```

测试覆盖：旧 JSON 导入与称呼字段、群文件去重、捕获/记忆/绑定/遗忘、符号链接共享同一库、跨频道平台解析。

## 自我维护闭环

每个工作区自己拥有数据库、备份和后台维护生命周期。插件注册后台 service + scheduler，按工作区定时执行备份、校验、安全修复、健康检查和画像压缩；确定性和语义维护都封在插件内部。

| 能力 | 负责方 |
|---|---|
| 定时唤醒与并发控制 | 插件后台 service + 宿主 scheduler |
| 备份、修复、校验、健康、同族归并、裸行清理 | 插件确定性代码 |
| 画像压缩、证据核对 | 插件内部无工具、无投递隔离模型调用 |
| 写入与回滚 | 插件统一走 `PeopleDatabase`，先备份后修改 |
| 对外输出 | 仅计数、状态和错误摘要；不输出画像原文，不向群投递 |

main 与 orion 共用工作区库，只跑一轮维护；public 独立工作区库，单独跑一轮。插件升级后所有工作区一起生效，不需要改 agent 提示词。`people_cycle` 默认只读显示最近维护摘要，属于 owner 诊断入口；owner 可用 `run: true` 手动触发同一套插件内部逻辑，并与后台 service 共用工作区互斥锁。旧定时任务模板不再随包发布；升级后 service 启动会自动清理本插件旧周期任务，可用 `openclaw cron list --json | rg 'people-cycle|people-scan' || true` 核对。owner 只认宿主本轮 `senderIsOwner`；内部维护不由「没有 requesterSenderId」的 agent 工具轮次提权。

维护规则见 `SELF-MANAGEMENT.md`；运行流程、手动调用和验收命令见 `RUNBOOK.md`。

## 隐私

- 数据库按工作区隔离（默认 `<stateDir>/plugins/people/<workspace-key>/people.db`），不同工作区互不可见。
- `people_lookup` 对非 owner 只允许查自己。
- owner 身份由宿主授权链决定：只使用工具工厂上下文或本轮入站 claim 的 `senderIsOwner`，插件不根据 sender ID、画像角色、会话历史或配置白名单推断 owner。
- 注入内容只给当前 agent，不进入对外回复；提示词明确要求不要原样展示。
- 默认 `people_forget` 只删活动库；备份快照和旧 JSON 归档仍会保留。需要彻底清除时显式传 `purge: true`，它会同时删除 `backups/` 与旧归档（不可恢复）。

## 安全边界

插件只依赖宿主授权链：agent 工具读取本轮 `senderIsOwner=true` 作为 owner 身份；缺失时就是普通调用，不根据 cron、heartbeat、subagent、agent ID、sender ID 或配置白名单补权。owner claim 按「工作区 + sessionKey + senderId」单次绑定，消费一次即删，不跨轮复用；新入站轮次只有宿主再次明确给出 owner 标记才生效。后台维护是插件内部调用，不通过 agent 工具走授权。

```json
{
  "plugins": {
    "entries": {
      "people": { "config": { "writeTools": true } }
    }
  }
}
```

- `writeTools`：写类工具总开关，默认 `true`；覆盖账号归并 `people_merge_account`。`capture` 只控制入站自动采集，`injectContext` 只控制注入；两者都不等于禁止工具写入。
- 非 owner 只能查询或写入自己及当前群的群记忆；跨账号、跨群读写和 `people_forget` 的 `purge` 仅 owner。
- agent 工具不接受 `workspace` 参数跨工作区；owner 权限也只在当前会话 agent 的工作区内有效。跨工作区要切换到该工作区的 agent 会话。
- 多个 `senderFamilies` 会各自独立归并；同一 sender id 不会跨 family 共享人物、特征或印象。
- `people_status` 给普通 agent 去标识化状态，owner 可见详细计数、路径、采集心跳和后台维护时间；`people_health` / `people_validate` / `people_cycle` 只给 owner 返回诊断或计数摘要，均不向普通 agent 暴露画像原文。

### 明确不做的部分及原因

- **不做强制同意弹窗**：插件只记录触发 agent 回复的发送者，不主动扫描潜水用户；强制弹窗会破坏自动记忆，也会让普通群聊无法使用。运营方应在部署说明里告知采集范围，或用 `capture: false` 关闭自动采集。
- **不在工具层做群成员 ACL**：群记忆只在该群会话中注入，跨账号查询已经限 owner；再叠加频道各自的成员 API 会把插件绑死在特定平台，违背「频道无关」的目标。
- **定时采集不自动安装**：插件只注册后台 service，不创建外部 automation；后台维护处理已有画像，不扫描群聊历史。
- **不管理宿主机权限**：工具可见性和沙箱由 OpenClaw 与 agent 策略控制，不属于插件包范围。
- **ClawHub readiness 的 `official` 项**：社区包不在官方频道，该项按设计就是 FAIL，不需要修。

ClawHub 的自动安全评审目前给 `review / suspicious`。0.0.4 报告中的跨 family 串人、账号归并绕过写开关、非 owner 跨工作区打开数据库和 Unicode 路径碰撞已由 0.0.5 修复；无发送者轮次的 agent 工具提权已由「只认宿主 owner 标记 + 插件内部维护」取代，并随 0.0.6 发布。剩余关注点是知情同意，以及普通遗忘仍保留备份；前者由部署说明 / `capture: false` 控制，后者由显式 `purge: true` 收紧。
