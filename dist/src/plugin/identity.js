import { resolvePlatform } from "../core/platform.js";
function record(value) {
    return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}
function firstString(source, keys) {
    for (const key of keys) {
        const value = source[key];
        if (typeof value === "string" && value.trim())
            return value.trim();
    }
    return undefined;
}
export function hookSenderName(ctx) {
    const sender = record(ctx.channelContext?.sender);
    return firstString(sender, [
        "name",
        "displayName",
        "display_name",
        "nickname",
        "username",
        "userName",
        "remark",
    ]);
}
export function hookChatId(ctx) {
    const chat = record(ctx.channelContext?.chat);
    return ctx.chatId?.trim() || firstString(chat, ["id", "chatId", "chat_id", "conversationId"]);
}
export function hookChatTitle(ctx) {
    const chat = record(ctx.channelContext?.chat);
    return firstString(chat, [
        "title",
        "name",
        "displayName",
        "display_name",
        "subject",
        "group_subject",
        "groupName",
    ]);
}
export function hookIsGroup(ctx) {
    const chat = record(ctx.channelContext?.chat);
    if (chat.isGroup === true || chat.is_group_chat === true || chat.isGroupChat === true)
        return true;
    const type = firstString(chat, ["type", "kind", "chat_type", "chatType"]);
    return type === "group" || type === "channel" || type === "supergroup";
}
export function hookPlatform(ctx, config) {
    const chat = record(ctx.channelContext?.chat);
    const sender = record(ctx.channelContext?.sender);
    const metadataPlatform = firstString(chat, ["platform", "provider"]) ?? firstString(sender, ["platform", "provider"]);
    return resolvePlatform({
        channel: ctx.channel,
        provider: ctx.messageProvider,
        accountId: ctx.accountId,
        metadataPlatform,
        template: config.platformTemplate,
        overrides: config.platformOverrides,
    });
}
export function inboundPlatform(event, config) {
    const metadata = record(event.metadata);
    const metadataPlatform = firstString(metadata, ["platform", "provider"]) ??
        firstString(record(metadata.chat), ["platform", "provider"]);
    return resolvePlatform({
        channel: event.channel,
        accountId: event.accountId,
        metadataPlatform,
        template: config.platformTemplate,
        overrides: config.platformOverrides,
    });
}
export function inboundGroupTitle(event) {
    const metadata = record(event.metadata);
    return (firstString(metadata, ["group_subject", "groupSubject", "groupName", "group_name"]) ??
        firstString(record(metadata.chat), ["title", "name", "subject"]));
}
