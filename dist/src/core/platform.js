const GENERIC_ACCOUNTS = new Set(["default", "main", "primary", "0", "none", "-"]);
function clean(value) {
    if (typeof value !== "string")
        return undefined;
    const trimmed = value.trim();
    return trimmed ? trimmed : undefined;
}
export function normalizePlatform(value) {
    return value.trim().replace(/\s+/g, "").replace(/\/{2,}/g, "/").replace(/^\/+|\/+$/g, "");
}
/** Stable comparison key: `bncr/tgBot` and `bncr:tgBot` compare equal. */
export function platformLookupKey(value) {
    return normalizePlatform(value).toLowerCase().replace(/[:/]+/g, ":");
}
export function parsePlatformFolder(folder) {
    const index = folder.indexOf("_");
    if (index <= 0)
        return folder;
    return `${folder.slice(0, index)}/${folder.slice(index + 1)}`;
}
export function resolvePlatform(params) {
    const metadataPlatform = clean(params.metadataPlatform);
    const channel = clean(params.provider) ?? clean(params.channel);
    const account = clean(params.accountId);
    if (metadataPlatform && (!channel || metadataPlatform.toLowerCase().startsWith(channel.toLowerCase()))) {
        return normalizePlatform(metadataPlatform);
    }
    if (!channel)
        return normalizePlatform(metadataPlatform ?? "unknown");
    const overrideKey = Object.keys(params.overrides ?? {}).find((key) => key.toLowerCase() === channel.toLowerCase());
    const template = (overrideKey ? params.overrides?.[overrideKey] : undefined) ?? params.template ?? "{channel}/{account}";
    const usableAccount = account && !GENERIC_ACCOUNTS.has(account.toLowerCase()) ? account : "";
    const rendered = template
        .replaceAll("{channel}", channel)
        .replaceAll("{account}", usableAccount)
        .replaceAll("{accountId}", usableAccount);
    const cleaned = rendered
        .split("/")
        .map((part) => part.trim())
        .filter(Boolean)
        .join("/");
    return cleaned || channel;
}
/** Group keys keep the legacy colon form: `bncr/tgBot` + chat -> `bncr:tgBot:<chat>`.
 */
export function groupKey(platform, chatId) {
    return `${normalizePlatform(platform).replace(/\//g, ":")}:${chatId.trim()}`;
}
