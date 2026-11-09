import { normalizePlatform, resolvePlatform } from "../core/platform.js";
import type { PeoplePluginConfig } from "../core/types.js";

type Dict = Record<string, unknown>;
type BncrTarget = { backend?: string; chatId?: string; isGroup?: boolean };

export type HookCtx = {
  agentId?: string;
  workspaceDir?: string;
  channel?: string;
  channelId?: string;
  messageProvider?: string;
  accountId?: string;
  chatId?: string;
  sessionKey?: string;
  runId?: string;
  senderId?: string;
  channelContext?: { sender?: Record<string, unknown>; chat?: Record<string, unknown> };
  deliveryContext?: { channel?: string; to?: string };
  nativeChannelId?: string;
};

export type InboundIdentityEvent = {
  agentId?: string;
  channel?: string;
  channelId?: string;
  messageProvider?: string;
  accountId?: string;
  senderId?: string;
  senderName?: string;
  conversationId?: string;
  parentConversationId?: string;
  sessionKey?: string;
  runId?: string;
  isGroup?: boolean;
  metadata?: Record<string, unknown>;
  commandAuthorized?: boolean;
  senderIsOwner?: boolean;
};

/** Host-provided second argument of inbound_claim / message_received. */
export type InboundIdentityContext = {
  channelId?: string;
  accountId?: string;
  conversationId?: string;
  parentConversationId?: string;
  senderId?: string;
  sessionKey?: string;
  runId?: string;
  agentId?: string;
  workspaceDir?: string;
};

export type ToolIdentityCtx = {
  agentId?: string;
  workspaceDir?: string;
  sessionKey?: string;
  runId?: string;
  messageChannel?: string;
  messageProvider?: string;
  agentAccountId?: string;
  requesterSenderId?: string;
  nativeChannelId?: string;
  deliveryContext?: { channel?: string; to?: string };
};

export type ResolvedIdentity = {
  channel: string;
  backend?: string;
  platform: string;
  source: "explicit" | "standard" | "session_fallback" | "deferred";
  workspaceKey?: string;
  agentId?: string;
  senderId?: string;
  senderName?: string;
  chatId?: string;
  chatTitle?: string;
  isGroup?: boolean;
  sessionKey?: string;
  runId?: string;
  senderIsOwner?: boolean;
  at: number;
};

function record(value: unknown): Dict {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Dict) : {};
}

function firstString(source: Dict, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = source[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return undefined;
}

function clean(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function channelName(...values: Array<string | undefined>): string | undefined {
  for (const value of values) {
    const trimmed = value?.trim();
    if (!trimmed) continue;
    const lower = trimmed.toLowerCase();
    if (lower.startsWith("channel:") || lower.startsWith("chat:") || lower.startsWith("user:") || lower.startsWith("group:")) {
      return trimmed.slice(trimmed.indexOf(":") + 1).trim() || undefined;
    }
    if (lower.startsWith("bncr:")) return "bncr";
    return trimmed.split(":")[0] || undefined;
  }
  return undefined;
}

function hexDecode(value: string): string | undefined {
  const segment = value.split(":").pop()?.trim() ?? "";
  if (!/^[0-9a-f]+$/iu.test(segment) || segment.length % 2 !== 0) return undefined;
  try {
    const decoded = Buffer.from(segment, "hex").toString("utf8");
    return /^[ -~]+$/u.test(decoded) ? decoded : undefined;
  } catch {
    return undefined;
  }
}

/** Standard BNCR targets have 4 segments; session scopes may have extra trailing fields. */
function parseBncrTarget(value: string | undefined): BncrTarget | undefined {
  if (!value) return undefined;
  let target = value.trim();
  const lower = target.toLowerCase();
  for (const prefix of ["channel:", "chat:", "user:", "group:"]) {
    if (lower.startsWith(prefix)) {
      target = target.slice(prefix.length).trim();
      break;
    }
  }
  const parts = target.split(":");
  if (parts.length < 4 || parts[0]?.toLowerCase() !== "bncr") return undefined;
  const backend = parts[1]?.trim();
  if (!backend || backend === "0") return undefined;
  const groupId = parts[2]?.trim();
  const userId = parts[3]?.trim();
  if (groupId?.toLowerCase() === "group" && userId && userId !== "0") {
    return { backend, chatId: userId, isGroup: true };
  }
  if (groupId === "0" && userId?.toLowerCase() === "user") {
    const directId = parts[4]?.trim();
    if (directId && directId !== "0") return { backend, chatId: directId, isGroup: false };
  }
  if (groupId && groupId !== "0") return { backend, chatId: groupId, isGroup: true };
  if (userId && userId !== "0") return { backend, chatId: userId, isGroup: false };
  return { backend };
}

function metadataFields(metadata: Dict): {
  to?: string;
  originatingTo?: string;
  from?: string;
  platform?: string;
  groupTitle?: string;
  senderId?: string;
} {
  return {
    to: firstString(metadata, ["to"]),
    originatingTo: firstString(metadata, ["originatingTo"]),
    from: firstString(metadata, ["from"]),
    platform:
      firstString(metadata, ["platform", "provider"]) ??
      firstString(record(metadata.chat), ["platform", "provider"]) ??
      firstString(record(metadata.sender), ["platform", "provider"]),
    groupTitle:
      firstString(metadata, ["group_subject", "groupSubject", "groupName", "group_name", "channelName"]) ??
      firstString(record(metadata.chat), ["title", "name", "subject"]),
    senderId: firstString(metadata, ["senderId", "sender_id"]),
  };
}

function normalizeBackendLabel(channel: string, value: unknown): string | undefined {
  const backend = clean(value);
  if (!backend || backend.toLowerCase() === channel.toLowerCase()) return undefined;
  const prefix = channel.toLowerCase() + "/";
  return backend.toLowerCase().startsWith(prefix) ? backend.slice(prefix.length) : backend;
}

function channelIdentity(params: {
  channel: string;
  backend?: string;
  platform?: string;
  config: PeoplePluginConfig;
}): string {
  const multi = params.config.multiAccountChannels ?? ["bncr"];
  const platform = clean(params.platform);
  if (platform && platform.includes("/")) return normalizePlatform(platform);
  return resolvePlatform({
    channel: params.channel,
    backend: multi.some((value) => value.toLowerCase() === params.channel.toLowerCase()) ? params.backend : undefined,
    backendChannels: multi,
    template: params.config.platformTemplate,
    overrides: params.config.platformOverrides,
  });
}

/** Standard host fields first; BNCR hex session segment is the last-resort fallback. */
function standardIdentity(params: {
  channel: string;
  multi: boolean;
  platform?: string;
  targets?: string[];
  sessionKey?: string;
  conversationId?: string;
  isGroup?: boolean;
  config: PeoplePluginConfig;
}): { backend?: string; chatId?: string; isGroup?: boolean; source: ResolvedIdentity["source"]; platform?: string } {
  const platform = normalizeBackendLabel(params.channel, params.platform);
  const conversation = clean(params.conversationId);
  const conversationTarget = params.multi ? parseBncrTarget(conversation) : undefined;
  const metadataTarget = params.multi
    ? params.targets?.map(parseBncrTarget).find(Boolean)
    : undefined;
  // Canonical metadata.to / originatingTo wins; a target-shaped native
  // conversation ID is the next standard field, ahead of any hex fallback.
  const target = metadataTarget ?? conversationTarget;
  const backend = platform ?? target?.backend;
  let chatId = params.multi
    ? (isHexLike(conversation) ? undefined : conversation)
    : conversation;
  if (params.multi && metadataTarget?.chatId && isBncrTargetChat(chatId)) {
    chatId = metadataTarget.chatId;
  } else if (params.multi && conversationTarget?.chatId) {
    chatId = conversationTarget.chatId;
  } else if (params.multi && !chatId) {
    chatId = target?.chatId;
  }
  const isGroup = params.isGroup ?? target?.isGroup;
  if (params.multi && !backend && params.sessionKey) {
    const fallback = parseBncrTarget(hexDecode(params.sessionKey));
    if (fallback?.backend) {
      return {
        backend: fallback.backend,
        chatId: chatId ?? fallback.chatId,
        isGroup: isGroup ?? fallback.isGroup,
        source: "session_fallback",
      };
    }
  }
  return {
    backend,
    chatId,
    isGroup,
    source: platform ? "explicit" : "standard",
    platform: backend ? `${params.channel}/${backend}` : undefined,
  };
}

function isHexLike(value: string | undefined): boolean {
  return Boolean(value && /^[0-9a-f]+$/iu.test(value.split(":").pop() ?? ""));
}

/** Host-native conversation IDs may be prefixed chat targets, not real chat IDs. */
function isBncrTargetChat(value: string | undefined): boolean {
  if (!value) return true;
  const lower = value.toLowerCase();
  const stripped = ["channel:", "chat:", "user:", "group:"]
    .find((prefix) => lower.startsWith(prefix));
  const parts = (stripped ? value.slice(stripped.length) : value).split(":");
  return parts.length >= 4 && parts[0]?.toLowerCase() === "bncr" && Boolean(parts[1]?.trim());
}

export function hookSenderName(ctx: HookCtx): string | undefined {
  return firstString(record(ctx.channelContext?.sender), ["name", "displayName", "display_name", "nickname", "username", "userName", "remark"]);
}

export function hookChatTitle(ctx: HookCtx): string | undefined {
  return firstString(record(ctx.channelContext?.chat), ["title", "name", "displayName", "display_name", "subject", "group_subject", "groupName"]);
}

export function hookIsGroup(ctx: HookCtx): boolean {
  const chat = record(ctx.channelContext?.chat);
  if (chat.isGroup === true || chat.is_group_chat === true || chat.isGroupChat === true) return true;
  const type = firstString(chat, ["type", "kind", "chat_type", "chatType"]);
  return type === "group" || type === "channel" || type === "supergroup";
}

export function inboundGroupTitle(event: InboundIdentityEvent): string | undefined {
  return metadataFields(record(event.metadata)).groupTitle;
}

export function resolveInboundIdentity(
  event: InboundIdentityEvent,
  config: PeoplePluginConfig,
  context?: InboundIdentityContext,
  workspaceKey?: string,
): ResolvedIdentity | undefined {
  const metadata = record(event.metadata);
  const fields = metadataFields(metadata);
  const channel = channelName(event.channel, event.channelId, context?.channelId, event.messageProvider);
  if (!channel) return undefined;
  const multi = (config.multiAccountChannels ?? ["bncr"]).some((value) => value.toLowerCase() === channel.toLowerCase());
  const resolved = standardIdentity({
    channel,
    multi,
    platform: multi ? fields.platform : undefined,
    targets: [fields.to, fields.originatingTo, fields.from].filter(
      (value): value is string => Boolean(value),
    ),
    sessionKey: clean(event.sessionKey) ?? clean(context?.sessionKey),
    conversationId: clean(event.conversationId) ?? clean(context?.conversationId) ?? clean(context?.parentConversationId),
    isGroup: event.isGroup,
    config,
  });
  if (multi && !resolved.backend) {
    return {
      channel,
      platform: channelIdentity({ channel, config }),
      source: "deferred",
      workspaceKey,
      agentId: context?.agentId,
      senderId: clean(event.senderId) ?? clean(context?.senderId) ?? fields.senderId,
      sessionKey: clean(event.sessionKey) ?? clean(context?.sessionKey),
      runId: clean(event.runId) ?? clean(context?.runId),
      senderIsOwner: event.senderIsOwner,
      at: Date.now(),
    };
  }
  let chatId = resolved.chatId;
  if (isHexLike(chatId)) {
    chatId = clean(context?.parentConversationId) ?? (isHexLike(clean(context?.conversationId)) ? undefined : clean(context?.conversationId)) ?? chatId;
  }
  return {
    channel,
    backend: resolved.backend,
    platform: channelIdentity({ channel, backend: resolved.backend, platform: resolved.platform, config }),
    source: resolved.source,
    workspaceKey,
    agentId: context?.agentId,
    senderId: clean(event.senderId) ?? clean(context?.senderId) ?? fields.senderId,
    senderName: clean(event.senderName) ?? firstString(metadata, ["senderName", "sender_name"]),
    chatId,
    chatTitle: fields.groupTitle,
    isGroup: resolved.isGroup,
    sessionKey: clean(event.sessionKey) ?? clean(context?.sessionKey),
    runId: clean(event.runId) ?? clean(context?.runId),
    senderIsOwner: event.senderIsOwner,
    at: Date.now(),
  };
}

export function resolveHookIdentity(
  ctx: HookCtx,
  config: PeoplePluginConfig,
  inbound?: ResolvedIdentity,
  workspaceKey?: string,
  sessionFallbackKey?: string,
): ResolvedIdentity | undefined {
  const chat = record(ctx.channelContext?.chat);
  const sender = record(ctx.channelContext?.sender);
  const channel = channelName(ctx.channel, ctx.channelId, ctx.messageProvider, inbound?.channel);
  if (!channel) return undefined;
  const multi = (config.multiAccountChannels ?? ["bncr"]).some((value) => value.toLowerCase() === channel.toLowerCase());
  const resolved = standardIdentity({
    channel,
    multi,
    platform: multi ? firstString(chat, ["platform", "provider"]) ?? firstString(sender, ["platform", "provider"]) : undefined,
    targets: [ctx.deliveryContext?.to].filter((value): value is string => Boolean(value)),
    sessionKey: sessionFallbackKey,
    conversationId: clean(ctx.chatId) ?? firstString(chat, ["id", "chatId", "chat_id", "conversationId"]),
    isGroup: hookIsGroup(ctx) || undefined,
    config,
  });
  const backend = multi ? inbound?.backend ?? resolved.backend : undefined;
  if (multi && !backend) {
    return {
      channel,
      platform: channelIdentity({ channel, config }),
      source: "deferred",
      workspaceKey,
      agentId: ctx.agentId,
      senderId: clean(ctx.senderId) ?? inbound?.senderId,
      sessionKey: clean(ctx.sessionKey) ?? inbound?.sessionKey,
      runId: clean(ctx.runId) ?? inbound?.runId,
      at: Date.now(),
    };
  }
  let chatId = inbound?.chatId ?? resolved.chatId ?? ctx.nativeChannelId;
  if (isHexLike(chatId) && !isHexLike(inbound?.chatId)) chatId = resolved.chatId ?? chatId;
  return {
    channel,
    backend,
    source: inbound?.source === "deferred" ? resolved.source : inbound?.source ?? resolved.source,
    platform: channelIdentity({ channel, backend, config }),
    workspaceKey,
    agentId: ctx.agentId,
    senderId: clean(ctx.senderId) ?? inbound?.senderId,
    senderName: hookSenderName(ctx) ?? inbound?.senderName,
    chatId,
    chatTitle: hookChatTitle(ctx) ?? inbound?.chatTitle,
    isGroup: inbound?.isGroup ?? resolved.isGroup ?? hookIsGroup(ctx),
    sessionKey: clean(ctx.sessionKey) ?? inbound?.sessionKey,
    runId: clean(ctx.runId) ?? inbound?.runId,
    at: Date.now(),
  };
}

/** Tool turns use host-normalized fields and the same inbound identity cache. */
export function resolveToolIdentity(
  ctx: ToolIdentityCtx,
  config: PeoplePluginConfig,
  inbound?: ResolvedIdentity,
  workspaceKey?: string,
): ResolvedIdentity | undefined {
  const channel = channelName(ctx.messageChannel, ctx.messageProvider, ctx.deliveryContext?.channel, inbound?.channel);
  if (!channel) return undefined;
  const multi = (config.multiAccountChannels ?? ["bncr"]).some((value) => value.toLowerCase() === channel.toLowerCase());
  const resolved = standardIdentity({
    channel,
    multi,
    targets: [ctx.deliveryContext?.to].filter((value): value is string => Boolean(value)),
    sessionKey: ctx.sessionKey,
    conversationId: ctx.nativeChannelId,
    config,
  });
  const backend = multi ? inbound?.backend ?? resolved.backend : undefined;
  if (multi && !backend) {
    return {
      channel,
      platform: channelIdentity({ channel, config }),
      source: "deferred",
      workspaceKey,
      agentId: ctx.agentId,
      senderId: clean(ctx.requesterSenderId) ?? inbound?.senderId,
      sessionKey: clean(ctx.sessionKey) ?? inbound?.sessionKey,
      runId: clean(ctx.runId) ?? inbound?.runId,
      at: Date.now(),
    };
  }
  let chatId = inbound?.chatId ?? resolved.chatId;
  if (isHexLike(chatId) && !isHexLike(inbound?.chatId)) chatId = resolved.chatId ?? chatId;
  return {
    channel,
    backend,
    platform: channelIdentity({ channel, backend, config }),
    source: inbound?.source === "deferred" ? resolved.source : inbound?.source ?? resolved.source,
    workspaceKey,
    agentId: ctx.agentId,
    senderId: clean(ctx.requesterSenderId) ?? inbound?.senderId,
    chatId,
    isGroup: inbound?.isGroup ?? resolved.isGroup,
    sessionKey: clean(ctx.sessionKey) ?? inbound?.sessionKey,
    runId: clean(ctx.runId) ?? inbound?.runId,
    at: Date.now(),
  };
}
