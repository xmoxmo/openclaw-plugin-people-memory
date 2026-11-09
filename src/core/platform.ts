function clean(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

export function normalizePlatform(value: string): string {
  return value.trim().replace(/\s+/g, "").replace(/\/{2,}/g, "/").replace(/^\/+|\/+$/g, "");
}

/** Stable comparison key: `bncr/tgBot` and `bncr:tgBot` compare equal. */
export function platformLookupKey(value: string): string {
  return normalizePlatform(value).toLowerCase().replace(/[:/]+/g, ":");
}

export function parsePlatformFolder(folder: string): string {
  const index = folder.indexOf("_");
  if (index <= 0) return folder;
  return `${folder.slice(0, index)}/${folder.slice(index + 1)}`;
}

export function resolvePlatform(params: {
  channel?: string;
  provider?: string;
  metadataPlatform?: string;
  backend?: string;
  backendChannels?: string[];
  template?: string;
  overrides?: Record<string, string>;
}): string {
  const metadataPlatform = clean(params.metadataPlatform);
  const channel = clean(params.provider) ?? clean(params.channel);
  const backend = clean(params.backend);

  if (metadataPlatform && (!channel || metadataPlatform.toLowerCase().startsWith(channel.toLowerCase()))) {
    return normalizePlatform(metadataPlatform);
  }
  if (!channel) return normalizePlatform(metadataPlatform ?? "unknown");
  const backendChannels = params.backendChannels ?? ["bncr"];
  if (backend && backendChannels.some((item) => item.toLowerCase() === channel.toLowerCase())) {
    return normalizePlatform(`${channel}/${backend}`);
  }

  const overrideKey = Object.keys(params.overrides ?? {}).find(
    (key) => key.toLowerCase() === channel.toLowerCase(),
  );
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
export function groupKey(platform: string, chatId: string): string {
  return `${normalizePlatform(platform).replace(/\//g, ":")}:${chatId.trim()}`;
}
