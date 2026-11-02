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
- 平台标签由 `channel + accountId` 按模板生成：普通频道就是频道名（如 `telegram`）；BNCR 这种一条接入带多个后端的频道，accountId 是后端（`bncr/GewePlus`、`bncr/tgBot` 等）。这是标签上的差异，不影响可用性。
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
| `people_status` | 当前工作区计数、扫描时间、数据库路径 | 所有 agent |
| `people_lookup` | 查自己、指定账号/人物或群记忆；`account`、`person`、`query` 都可引用，`full: true` 返回完整 traits 和印象列表 | 查他人仅 owner |
| `people_remember` | 记一条事实/印象，可写入维度（key 或中文标签均可）；`person` 参数用于人物级画像 | 自己；owner 或内部周期任务可指定他人/人物 |
| `people_name` | 设置 call_name / confirmed_name / 人物名 | 自己；owner 可指定他人 |
| `people_note` | 追加群记忆 | 当前群成员 |
| `people_bind` | 账号绑定到人物，合并画像 | owner |
| `people_forget` | 删除匹配的印象/特征；`scope` 限定范围；`purge: true` 同时清除备份与旧归档（不可恢复） | 自己；owner 或内部周期任务可指定他人/人物 |
| `people_validate` | 一致性校验，可选修复 | 读取所有；修复仅 owner |
| `people_scan_mark` | 记录扫描进度 | 扫描任务 |
| `people_bootstrap` | 建库、导入旧 JSON | 所有 agent（其他工作区仅 owner） |
| `people_backup` | 生成 SQLite + JSON 备份并轮换旧备份 | 当前工作区 |
| `people_health` | 检查重复人物、过密画像、孤儿记录、缺备份 | 当前工作区 |
| `people_cycle` | 插件化维护周期：按需备份、修复、健康检查并生成待办计划 | owner / 内部周期任务 |
| `people_search` | 跨账号、人物、印象、群事件搜索 | owner / 内部维护任务 |
| `people_dimension` | 查看、添加、启停画像维度 | 查看所有；修改 owner / 内部维护任务 |
| `people_merge` | 合并重复人物 | owner / 内部维护任务，需 confirm |
| `people_merge_account` | 合并同一人物的双份账号，迁移印象、特征、群成员和绑定 | owner / 内部维护任务，需 confirm |
| `people_unbind` | 解绑账号并默认复制人物画像回账号 | owner / 内部维护任务，需 confirm |

账号引用可写规范 id（`bncr/GewePlus:wxid_x`），也可写 `bncr:GewePlus:wxid_x`。群引用支持完整 group_id、纯数字 chat_id，以及 `GewePlus:123456789` 这类带平台前缀的写法。

## 自动行为

启用后，`inbound_claim` 会先被动记录发送者昵称、群标题和群聊标记（不存消息正文），解决 BNCR 这类不提供 `channelContext` 的频道拿不到昵称的问题。随后 `before_prompt_build` 在每轮对话前：

1. 从频道上下文解析平台、发送者、会话。
2. 首次见到账号时建档，更新 `display_name` 与 `last_interaction`。
3. 识别群会话时更新群标题与成员。
4. 注入一张 `<people_context>` 小卡片，包含当前对象画像和最近群记忆。

同一账号 30 秒内只写一次，避免重试和多轮调用造成写放大。任何异常都不会中断对话，只会记一条警告日志。

当某个画像的零散印象超过 12 条时，注入卡片会附带一条内部维护待办，提示 agent 在相关对话里归并画像。该提示只进入模型上下文，不会展示给用户。

## 频道兼容

平台标签由 `channel + accountId` 生成，不依赖 BNCR：

| 上下文 | 平台标签 |
|---|---|
| `provider=bncr, accountId=tgBot` | `bncr/tgBot` |
| `channel=telegram` | `telegram` |
| `channel=discord, accountId=work` | `discord/work` |

发送者名、群标题、是否群聊都按候选字段读取，兼容 `name / displayName / display_name / nickname / username`、`title / subject / group_subject`、`isGroup / type=group` 等常见形态。特殊频道可用 `platformOverrides` 覆盖平台模板。

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

## 开发

```bash
npm run build
npm test
```

测试覆盖：旧 JSON 导入与称呼字段、群文件去重、捕获/记忆/绑定/遗忘、符号链接共享同一库、跨频道平台解析。

## 自我维护闭环

每个工作区自己拥有数据库、备份和维护任务。推荐任务分工：

| 任务 | 频率 | 作用 |
|---|---|---|
| 工作区周期任务 | 每 6 小时 | 调用 `people_cycle` 执行插件维护，再补捞该工作区的会话事实 |

main 和 orion 共用一套库，由一个 home 周期任务处理 `agent:main` 和 `agent:orion` 的会话；public 使用自己的周期任务。备份间隔、校验、健康检查和待办清理由插件决定，定时器只负责叫醒 agent。

维护任务的完整执行规则见 `SELF-MANAGEMENT.md`；运行流程、手动调用和验收命令见 `RUNBOOK.md`。

## 隐私

- 数据库按工作区隔离（默认 `<stateDir>/plugins/people/<workspace-key>/people.db`），不同工作区互不可见。
- `people_lookup` 对非 owner 只允许查自己。
- 注入内容只给当前 agent，不进入对外回复；提示词明确要求不要原样展示。
- 默认 `people_forget` 只删活动库；备份快照和旧 JSON 归档仍会保留。需要彻底清除时显式传 `purge: true`，它会同时删除 `backups/` 与旧归档（不可恢复）。

## 安全边界与严格模式

默认配置与旧版本行为一致：没有 `requesterSenderId` 的轮次（cron、heartbeat、subagent、公开入口）按内部维护身份处理。这保证了定时维护开箱即用，但把「内部任务」和「公开入口」放在了同一类。需要收紧时开启严格模式：

```json
{
  "plugins": {
    "entries": {
      "people": {
        "config": {
          "internalAdminAgents": ["main", "orion"],
          "writeTools": true
        }
      }
    }
  }
}
```

- `internalAdminAgents`：一旦设置（哪怕是空数组），无发送者轮次只有名单内 agent 能执行维护类操作。**启用后要把运行周期任务的 agent 也列进来**，否则 `people_cycle` 会被拒绝。不设置则保持兼容默认。
- `writeTools`：写类工具总开关，默认 `true`。`capture` 只控制入站自动采集，`injectContext` 只控制注入；两者都不等于禁止工具写入。
- 非 owner 只能查询或写入当前群的群记忆；跨群读写需要 owner 或内部维护身份。`people_forget` 的 `purge` 也仅限 owner 或内部维护身份。
- `people_status` / `openclaw people status` 会显示当前安全模式；兼容模式下会提示可以启用严格模式。

### 明确不做的部分及原因

- **不做强制同意弹窗**：插件只记录触发 agent 回复的发送者，不主动扫描潜水用户；强制弹窗会破坏自动记忆，也会让普通群聊无法使用。运营方应在部署说明里告知采集范围，或用 `capture: false` 关闭自动采集。
- **不在工具层做群成员 ACL**：群记忆只在该群会话中注入，跨账号查询已经限 owner；再叠加频道各自的成员 API 会把插件绑死在特定平台，违背「频道无关」的目标。
- **定时采集不自动安装**：插件不创建 automation，周期任务由运营方显式建立——这一步本身就是「单独批准」。
- **不管理宿主机权限**：工具可见性和沙箱由 OpenClaw 与 agent 策略控制，不属于插件包范围。
- **ClawHub readiness 的 `official` 项**：社区包不在官方频道，该项按设计就是 FAIL，不需要修。

ClawHub 的自动安全评审目前给 `review / suspicious`，关注点是知情同意、共享访问控制和删除完整性。前两项属于产品与部署边界，第三项已通过 `purge` 提供显式路径；默认行为保持不变。
