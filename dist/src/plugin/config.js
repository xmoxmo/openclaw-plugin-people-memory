export function normalizeConfig(raw) {
    const value = (raw ?? {});
    const str = (key, fallback) => typeof value[key] === "string" && value[key].trim()
        ? value[key].trim()
        : fallback;
    const bool = (key, fallback) => typeof value[key] === "boolean" ? value[key] : fallback;
    const list = (key) => Array.isArray(value[key])
        ? value[key].filter((item) => typeof item === "string")
        : [];
    const record = (key) => {
        const rawRecord = value[key];
        if (!rawRecord || typeof rawRecord !== "object" || Array.isArray(rawRecord))
            return {};
        return Object.fromEntries(Object.entries(rawRecord).filter((entry) => typeof entry[1] === "string"));
    };
    return {
        dataDir: str("dataDir", "{stateDir}/plugins/people/{workspaceKey}"),
        workspaceDataDirs: record("workspaceDataDirs"),
        databaseFile: str("databaseFile", "people.db"),
        injectContext: bool("injectContext", true),
        injectGroupMemory: bool("injectGroupMemory", true),
        injectMaxChars: typeof value.injectMaxChars === "number" && Number.isFinite(value.injectMaxChars)
            ? Math.max(201, Math.min(20_000, Math.trunc(value.injectMaxChars)))
            : 1200,
        disabledAgents: list("disabledAgents"),
        capture: bool("capture", true),
        captureGroups: bool("captureGroups", true),
        captureSkipSenders: (() => {
            const skip = list("captureSkipSenders");
            return skip.length ? skip : undefined;
        })(),
        writeTools: bool("writeTools", true),
        importLegacy: bool("importLegacy", true),
        platformTemplate: str("platformTemplate", "{channel}"),
        multiAccountChannels: (() => {
            if (value.multiAccountChannels === undefined)
                return undefined;
            // An explicit empty list disables multi-account identity spaces. Only an
            // omitted or invalid value inherits the built-in BNCR default.
            return Array.isArray(value.multiAccountChannels) ? list("multiAccountChannels") : undefined;
        })(),
        platformOverrides: record("platformOverrides"),
        senderFamilies: (() => {
            const raw = value.senderFamilies;
            if (raw === undefined)
                return undefined;
            if (!Array.isArray(raw))
                return undefined;
            const families = [];
            for (const family of raw) {
                if (!Array.isArray(family))
                    continue;
                const labels = family
                    .filter((item) => typeof item === "string" && Boolean(item.trim()))
                    .map((item) => item.trim());
                if (labels.length === 2)
                    families.push(labels);
            }
            // An explicit empty list disables the built-in same-sender family
            // defaults; an omitted value still inherits them from the service.
            return families;
        })(),
        debug: bool("debug", false),
    };
}
export function isAgentDisabled(config, agentId) {
    if (!agentId)
        return false;
    return (config.disabledAgents ?? []).some((value) => value.trim() === agentId);
}
