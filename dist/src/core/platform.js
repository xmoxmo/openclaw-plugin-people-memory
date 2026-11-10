function clean(value) {
    if (typeof value !== "string")
        return undefined;
    const trimmed = value.trim();
    return trimmed ? trimmed : undefined;
}
export function normalizePlatform(value) {
    const normalized = value
        .trim()
        .replace(/\s+/g, "")
        .replace(/\/{2,}/g, "/")
        .replace(/^\/+|\/+$/g, "");
    const legacy = /^([^/:]+):([^/]+)$/u.exec(normalized);
    return legacy ? `${legacy[1]}/${legacy[2]}` : normalized;
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
    const backend = clean(params.backend);
    const metadataChannel = metadataPlatform?.split(/[:/]/u, 1)[0]?.trim();
    if (metadataPlatform &&
        (!channel || metadataChannel?.toLowerCase() === channel.toLowerCase())) {
        const normalized = normalizePlatform(metadataPlatform);
        const separator = normalized.indexOf(":");
        if (separator > 0) {
            const metadataChannel = normalized.slice(0, separator);
            const metadataBackend = normalized.slice(separator + 1);
            const backendChannels = params.backendChannels ?? ["bncr"];
            if (metadataBackend &&
                backendChannels.some((item) => item.trim().toLowerCase() === metadataChannel.toLowerCase())) {
                return normalizePlatform(`${metadataChannel}/${metadataBackend}`);
            }
        }
        return normalized;
    }
    if (!channel)
        return normalizePlatform(metadataPlatform ?? "unknown");
    const backendChannels = params.backendChannels ?? ["bncr"];
    if (backend && backendChannels.some((item) => item.trim().toLowerCase() === channel.toLowerCase())) {
        return normalizePlatform(`${channel}/${backend}`);
    }
    const overrideKey = Object.keys(params.overrides ?? {}).find((key) => key.toLowerCase() === channel.toLowerCase());
    const template = (overrideKey ? params.overrides?.[overrideKey] : undefined) ?? params.template ?? "{channel}";
    const rendered = template
        .replaceAll("{channel}", channel)
        .replaceAll("{backend}", "")
        .replaceAll("{account}", "")
        .replaceAll("{accountId}", "");
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
