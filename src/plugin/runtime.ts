import fs from "node:fs";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { resolveStorePaths, resolveWorkspaceRoot } from "../core/paths.js";
import { PeopleService } from "../core/service.js";
import type { PeoplePluginConfig } from "../core/types.js";
import { normalizeConfig } from "./config.js";

export type WorkspaceContext = {
  workspaceDir?: string;
  agentId?: string;
  agentDir?: string;
};

export class PeopleRuntime {
  readonly api: OpenClawPluginApi;
  readonly config: PeoplePluginConfig;
  private readonly cache = new Map<string, PeopleService>();

  constructor(api: OpenClawPluginApi) {
    this.api = api;
    this.config = normalizeConfig(api.pluginConfig);
  }

  private resolveStateDir(): string | undefined {
    try {
      return this.api.runtime?.state?.resolveStateDir?.(process.env);
    } catch {
      return undefined;
    }
  }

  private logDebug(message: string): void {
    if (this.config.debug) this.api.logger.info(`[people] ${message}`);
  }

  get(context: WorkspaceContext): PeopleService {
    const workspaceDir =
      context.workspaceDir?.trim() ||
      resolveWorkspaceRoot(
        this.api.config as Parameters<typeof resolveWorkspaceRoot>[0],
        context.agentId,
      );
    const paths = resolveStorePaths({
      workspaceDir,
      agentId: context.agentId,
      agentDir: context.agentDir,
      stateDir: this.resolveStateDir(),
      config: this.config,
    });
    const key = paths.workspaceKey;
    const existing = this.cache.get(key);
    if (existing && fs.existsSync(existing.paths.dbPath)) return existing;
    if (existing) {
      try {
        existing.close();
      } catch {
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

  closeAll(): void {
    for (const service of this.cache.values()) {
      try {
        service.close();
      } catch {
        // ignore
      }
    }
    this.cache.clear();
  }
}
