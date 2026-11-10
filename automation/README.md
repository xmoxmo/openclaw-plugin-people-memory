# 定时任务与后台维护（历史说明）

> 当前插件由宿主后台 service 自维护；`people-cycle-home` / `people-cycle-public` 已清理。本目录的提示词不参与当前运行，保留为迁移历史。

## 现行方式

插件加载时注册 `people-maintenance` service。宿主 scheduler 按每个工作区约 6 小时触发一次，备份、修复、校验、画像压缩和结果写回全在插件内部完成，不叫醒普通 agent，不向群聊投递，也不读取聊天历史。

- `people_status`：看后台 service 启动、最近调度、最近完成和失败摘要。
- `people_cycle`：默认只读看最近维护摘要；owner 可用 `run: true` 手动触发一轮，仍只返回计数摘要。
- `openclaw plugins inspect people --runtime --json`：确认 `services` 含 `people-maintenance`。

## 为什么旧提示词不再使用

| 文件 | 状态 |
|---|---|
| `cycle.template.md` | 历史模板；旧版要求 agent 补捞会话、查看画像原文、执行 compact / merge_review |
| `cycle-home.md` / `cycle-public.md` | 本机历史实例，含本机路径，不随公开包发布 |
| `scan-orion.md` / `scan-public.md` | 更早期独立扫描任务，已停用 |

这些步骤与当前「插件内部闭环、普通 agent 不接触画像原文、不用 cron 提权」的边界冲突。不要重新注册，也不要把它们复制到新 agent 的提示词里。

## 发布包范围

`package.json` 的 `files` 不含 `automation/`，本目录只留在本机工作仓，不随 npm / ClawHub 包发布。插件完整性由 `skills/people-identifier/SKILL.md` 和插件内置后台 service 提供，安装后无需新建定时任务。

## 升级迁移

插件的 `people-maintenance` service 启动时会从宿主插件作用域 cron API 列出任务，只移除本插件旧周期任务：已知历史名（含更早期的 `person-scan-wind` / `person-scan-rain`），或带 `people:` declarationKey 且名称 / 描述 / 托管 payload 命中旧周期证据的任务。仅名称相似、仅描述里提到 `people_cycle` 的用户自建任务不会被删。清理失败只记 warning，不阻断后台 service。

只读核对：

```bash
openclaw cron list --json | rg 'people-cycle|people-scan' || true
```

升级后如果仍看到旧任务，先重载插件让 service 再运行一次；确属旧任务时才手动 `openclaw cron remove <id>`。
