import fs from "node:fs";
import os from "node:os";
import path from "node:path";
const DEFAULT_STATE_DIR = path.join(os.homedir(), ".openclaw");
export function expandTemplate(template, values) {
    const home = values.homeDir ?? os.homedir();
    const stateDir = values.stateDir ?? DEFAULT_STATE_DIR;
    const workspaceKey = values.workspaceKey ?? encodeWorkspaceSegment(values.workspace);
    const expanded = template
        .replaceAll("{workspace}", values.workspace)
        .replaceAll("{workspaceDir}", values.workspace)
        .replaceAll("{stateDir}", stateDir)
        .replaceAll("{workspaceKey}", workspaceKey)
        .replaceAll("{agentDir}", values.agentDir ?? "")
        .replaceAll("{agentId}", values.agentId ?? "")
        .replaceAll("{home}", home);
    if (expanded === "~")
        return home;
    if (expanded.startsWith("~/"))
        return path.join(home, expanded.slice(2));
    return expanded;
}
export function toAbsolute(value, base) {
    return path.isAbsolute(value) ? path.normalize(value) : path.resolve(base, value);
}
export function realpathOrResolve(value) {
    try {
        return fs.realpathSync.native(value);
    }
    catch {
        return path.resolve(value);
    }
}
export function ensureDir(dir) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
}
/** Stable, readable directory name for a workspace's state directory. */
export function encodeWorkspaceSegment(workspaceDir) {
    const real = realpathOrResolve(workspaceDir);
    const trimmed = real.replace(/^[/\\]+/, "");
    // Escape literal underscores before collapsing path separators to "__", so
    // "/a/b" and "/a__b" map to different directories (workspace isolation).
    // Paths without underscores keep their previous directory name.
    const slug = trimmed
        .replace(/_/g, "_5f")
        .replace(/[/\\]+/g, "__")
        .replace(/[^A-Za-z0-9._-]/g, "_");
    return slug || "workspace";
}
export function resolveStorePaths(params) {
    const config = params.config ?? {};
    const workspaceDir = realpathOrResolve(params.workspaceDir);
    const stateDir = params.stateDir?.trim() || DEFAULT_STATE_DIR;
    const workspaceKey = encodeWorkspaceSegment(workspaceDir);
    const overrides = config.workspaceDataDirs ?? {};
    const templateValues = {
        workspace: workspaceDir,
        stateDir,
        workspaceKey,
        agentId: params.agentId,
        agentDir: params.agentDir,
    };
    let dataDir;
    for (const [key, value] of Object.entries(overrides)) {
        if (!value)
            continue;
        const candidate = realpathOrResolve(expandTemplate(key, templateValues));
        if (candidate === workspaceDir) {
            dataDir = expandTemplate(value, templateValues);
            break;
        }
    }
    if (!dataDir) {
        const template = config.dataDir?.trim() || "{stateDir}/plugins/people/{workspaceKey}";
        dataDir = expandTemplate(template, templateValues);
    }
    dataDir = toAbsolute(dataDir, workspaceDir);
    const databaseFile = config.databaseFile?.trim() || "people.db";
    const dbPath = path.isAbsolute(databaseFile)
        ? databaseFile
        : path.join(dataDir, databaseFile);
    return {
        workspaceDir,
        dataDir,
        dbPath,
        workspaceKey: realpathOrResolve(dataDir),
    };
}
export function resolveWorkspaceRoot(config, agentId) {
    const entry = agentId ? config.agents?.entries?.[agentId] : undefined;
    const explicit = entry?.workspace?.trim();
    if (explicit)
        return explicit;
    const base = config.agents?.defaults?.workspace?.trim() || path.join(os.homedir(), ".openclaw", "workspace");
    // OpenClaw gives the default agent the base workspace and each additional
    // agent its own child directory, unless that agent sets workspace explicitly.
    if (!agentId || agentId === "main")
        return base;
    return path.join(base, agentId);
}
