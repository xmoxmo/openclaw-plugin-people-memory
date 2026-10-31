import fs from "node:fs";
import { resolveStorePaths, resolveWorkspaceRoot } from "../core/paths.js";
import { PeopleService } from "../core/service.js";
import { normalizeConfig } from "./config.js";
export class PeopleRuntime {
    api;
    config;
    cache = new Map();
    constructor(api) {
        this.api = api;
        this.config = normalizeConfig(api.pluginConfig);
    }
    resolveStateDir() {
        try {
            return this.api.runtime?.state?.resolveStateDir?.(process.env);
        }
        catch {
            return undefined;
        }
    }
    logDebug(message) {
        if (this.config.debug)
            this.api.logger.info(`[people] ${message}`);
    }
    get(context) {
        const workspaceDir = context.workspaceDir?.trim() ||
            resolveWorkspaceRoot(this.api.config, context.agentId);
        const paths = resolveStorePaths({
            workspaceDir,
            agentId: context.agentId,
            agentDir: context.agentDir,
            stateDir: this.resolveStateDir(),
            config: this.config,
        });
        const key = paths.workspaceKey;
        const existing = this.cache.get(key);
        if (existing && fs.existsSync(existing.paths.dbPath))
            return existing;
        if (existing) {
            try {
                existing.close();
            }
            catch {
                // ignore
            }
            this.cache.delete(key);
        }
        this.logDebug(`open ${paths.dbPath} (agent=${context.agentId ?? "?"})`);
        const service = new PeopleService({
            paths,
            config: this.config,
            logger: {
                info: (message) => this.api.logger.info(message),
                warn: (message) => this.api.logger.warn(message),
                debug: (message) => this.logDebug(message),
            },
        });
        this.cache.set(key, service);
        return service;
    }
    closeAll() {
        for (const service of this.cache.values()) {
            try {
                service.close();
            }
            catch {
                // ignore
            }
        }
        this.cache.clear();
    }
}
