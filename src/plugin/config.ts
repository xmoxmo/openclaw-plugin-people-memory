import type { PeoplePluginConfig } from "../core/types.js";

export function normalizeConfig(raw: unknown): PeoplePluginConfig {
  const value = (raw ?? {}) as Record<string, unknown>;
  const str = (key: string, fallback: string): string =>
    typeof value[key] === "string" && (value[key] as string).trim()
      ? (value[key] as string).trim()
      : fallback;
  const bool = (key: string, fallback: boolean): boolean =>
    typeof value[key] === "boolean" ? (value[key] as boolean) : fallback;
  const list = (key: string): string[] =>
    Array.isArray(value[key])
      ? (value[key] as unknown[]).filter((item): item is string => typeof item === "string")
      : [];
  const record = (key: string): Record<string, string> => {
    const rawRecord = value[key];
    if (!rawRecord || typeof rawRecord !== "object" || Array.isArray(rawRecord)) return {};
    return Object.fromEntries(
      Object.entries(rawRecord as Record<string, unknown>).filter(
        (entry): entry is [string, string] => typeof entry[1] === "string",
      ),
    );
  };

  return {
    dataDir: str("dataDir", "{stateDir}/plugins/people/{workspaceKey}"),
    workspaceDataDirs: record("workspaceDataDirs"),
    databaseFile: str("databaseFile", "people.db"),
    injectContext: bool("injectContext", true),
    injectGroupMemory: bool("injectGroupMemory", true),
    injectMaxChars:
      typeof value.injectMaxChars === "number" && value.injectMaxChars > 200
        ? value.injectMaxChars
        : 1200,
    disabledAgents: list("disabledAgents"),
    capture: bool("capture", true),
    captureGroups: bool("captureGroups", true),
    captureSkipSenders: (() => {
      const skip = list("captureSkipSenders");
      return skip.length ? skip : undefined;
    })(),
    importLegacy: bool("importLegacy", true),
    platformTemplate: str("platformTemplate", "{channel}/{account}"),
    multiAccountChannels: (() => {
      const channels = list("multiAccountChannels");
      return channels.length ? channels : undefined;
    })(),
    platformOverrides: record("platformOverrides"),
    senderFamilies: (() => {
      const raw = value.senderFamilies;
      if (raw === undefined) return undefined;
      if (!Array.isArray(raw)) return undefined;
      const families: string[][] = [];
      for (const family of raw) {
        if (!Array.isArray(family)) continue;
        const labels = family
          .filter((item): item is string => typeof item === "string" && Boolean(item.trim()))
          .map((item) => item.trim());
        if (labels.length >= 2) families.push(labels);
      }
      return families.length > 0 ? families : undefined;
    })(),
    debug: bool("debug", false),
  };
}

export function isAgentDisabled(config: PeoplePluginConfig, agentId: string | undefined): boolean {
  if (!agentId) return false;
  return (config.disabledAgents ?? []).some((value) => value.trim() === agentId);
}
