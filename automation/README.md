# 定时任务（周期维护）

people 插件的核心维护逻辑都在插件里（`people_cycle` 负责按需备份、自动修复、校验、生成待办）。定时任务只做一件事：**按周期叫醒 agent，让它调用插件**。控制面在插件，定时器只是触发器。

## 组成

| 文件 | 作用 |
|---|---|
| `cycle.template.md` | 通用周期维护提示词模板，含 `{{WORKSPACE}}` / `{{AGENT_IDS}}` / `{{AGENT_NAMES}}` 占位符 |
| `cycle-home.md` / `cycle-public.md` | 本机实例已用的两份具体任务（示例，含本机路径，不随公开包发布） |
| `scan-orion.md` / `scan-public.md` | 早期独立扫描任务，已停用，仅作历史参考 |

## 注册一个周期任务

用内置 `automations` 工具（旧名 `cron` 已不存在）。把 `cycle.template.md` 填好占位符后作为 `payload.message`：

```text
automations(action="add", job: {
  name: "people-cycle-<workspace>",
  schedule: { kind: "cron", expr: "0 */6 * * *", tz: "Asia/Shanghai" },
  sessionTarget: "isolated",
  wakeMode: "now",
  payload: {
    kind: "agentTurn",
    timeoutSeconds: 900,
    message: "<cycle.template.md 填好占位符后的全文>"
  },
  delivery: { mode: "none" },
  enabled: true
})
```

要点：

- **周期任务不设 `deleteAfterRun`**，否则跑一次就删。
- `delivery.mode = "none"`：维护任务只做内部整理，不向群播报。
- 一个工作区注册一个任务；同 workspaceDir 的多个 agent 由同一个任务覆盖（`{{AGENT_IDS}}` 里列全）。
- 如果开启了严格模式 `internalAdminAgents`，运行周期任务的 agent 必须写进这个名单，否则 `people_cycle` 会以「仅 owner 或内部维护任务」拒绝。未设置该配置时保持兼容默认，无需额外操作。
- 触发频率建议 6 小时一次；真正的备份/修复节奏由 `people_cycle` 内部决定，调频率只影响叫醒频率。

## 怎么确认在正常跑

```text
automations(action="list")                       // 看 nextRunAtMs / lastRunStatus
automations(action="runs", jobId="<job-id>", limit: 5)  // 看运行历史
```

再结合插件侧自检：`openclaw people status`、`openclaw people validate`、`openclaw people health`。

## 为什么不做成"纯定时任务"

如果维护逻辑写在定时任务提示词里，换一个 agent 就要复制一份、改一份，容易漏。现在维护逻辑收敛在 `people_cycle`，定时任务只负责叫醒，插件升级后所有工作区一起受益。

