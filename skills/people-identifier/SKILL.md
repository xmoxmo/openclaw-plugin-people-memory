---
name: people-identifier
description: "自动识人：people 插件每轮注入 <people_context> 画像与群记忆；用 people_* 工具记称呼、事实和群事件。触发词：我的画像、看看我的画像、我是谁、识人、记住我。"
---

# People Identifier — 自动识人

本技能是 people 插件的配套提示词。插件负责存储与注入，本技能负责告诉 agent 怎么用。

## 适用范围

- 插件读取的是**通用入站元信息**：发送者 id、显示昵称、群标题、是否群聊。任何能提供这些的频道都能用，不绑定平台。
- 平台标签由 `channel + accountId` 生成：普通频道用频道名；BNCR 一条接入带多个后端，accountId 是后端（`bncr/GewePlus`、`bncr/tgBot` 等）。
- 同族自动归并只针对 GewePlus 与 GolemPlus（两者 senderid 空间一致）；别的频道没有这种同 id 双接入，本来就不需要归并。bot 识别靠群 botNames + `current_role=bot`，是通用逻辑。
- 频道不提供昵称/群标题时，插件用 `inbound_claim` 被动补录，仍能建档。

## 数据从哪来

- 插件按工作区定位 `<workspace>/people/people.db`，同一 workspaceDir 的 agent 共用一份，不同工作区互不可见。
- 每轮消息前自动建档、同步平台昵称与群标题，并注入 `<people_context>`。
- 旧 JSON 只作归档，不再读写。

## 每轮怎么做

1. 直接用注入的卡片，不向用户复述卡片内容或流程。
2. 本人说「叫我X」→ `people_name { call_name: "X" }`。
3. 本人第一人称明确说出事实（所在地、身份、偏好、关系、近期计划）→ `people_remember { content, dimension }`。
4. 群规、里程碑、接口或功能变更 → `people_note { summary, category }`。
5. 查详细画像 → `people_lookup`；查当前群 → `people_lookup { group: "<chat_id>" }`（非 owner 只能查当前群）。

称呼优先级：call_name → confirmed_name → 平台昵称。称呼不脑补，不用 traits.basic_name 顶替。

## 查画像

1. `people_lookup`（不带参数）取当前发送者画像。
2. 返回插件生成的卡片；无记录 → 「你暂时还没有画像记录，多聊聊就有了」。
3. 只能查自己的画像，拒绝查别人。
4. 即使本人要求查别人，也尽量私信回复，不在群聊贴完整画像。
5. 禁止主动发布他人画像。

## 画像整理归并

1. `people_lookup` 查看现有 traits 与 impressions。
2. 按维度把 impressions 归并成精炼描述。
3. `people_remember { dimension, mode: "replace", content }` 写回；replace 只更新 traits，不追加印象。
4. `people_forget { scope: "impressions", match }` 删除被替代的原文，避免误删 traits。
5. impressions 收敛在 1-3 条。
6. 展示沿用插件卡片：称呼、初次见面、最近、各维度，只显示非空字段。

## 禁止

- 直接读写 `people/` 下的 JSON 或 `people.db`。
- 跑 `merge-platform-accounts`、`people-put`、`call-name` 这类旧工具。
- 主动绑定人物；只有 owner 明确要求才 `people_bind`。
- 把扫描流程、插件同步、cron 简报、工具报错写成群记忆或人物事实。

## Failure / Escalation

- `people_lookup` 报账号或群歧义（同 chat 多个后端行）→ 按提示改用精确 key `platform:chat_id`，不要猜。
- 写入报「只允许查自己 / 需要 owner」→ 说明权限边界，不绕过。
- 插件未加载或工具不存在 → 提示检查 `plugins.entries.people.enabled` 与沙箱 `alsoAllow`，不要改数据库。
- 发现裸平台行、重复账号、孤儿成员等异常 → 交给周期任务的 `people_cycle` / `people_validate { fix: true }` 处理，不手工改库。

