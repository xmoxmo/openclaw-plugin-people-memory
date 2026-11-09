import fs from "node:fs";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { resolveStorePaths, resolveWorkspaceRoot } from "../core/paths.js";
import { PeopleService } from "../core/service.js";
import type { CycleReport, PeoplePluginConfig } from "../core/types.js";
import type { MaintenanceServiceState } from "./service.js";
import { isAgentDisabled, normalizeConfig } from "./config.js";
import { IdentityStore } from "./identity-store.js";
import { isOlderThan } from "../core/time.js";
import { runSemanticMaintenance, type IsolatedCompletion, type SemanticMaintenanceResult } from "./maintenance.js";

export type WorkspaceContext = {
  workspaceDir?: string;
  agentId?: string;
  agentDir?: string;
};

export type MaintenanceWorkspace = {
  workspaceDir: string;
  agentId?: string;
};

export type MaintenanceSummary = {
  cycledAt: string;
  durationMs: number;
  workspaceKey: string;
  repairActions: number;
  backup: boolean;
  healthOk: boolean;
  semantic: SemanticMaintenanceResult;
};

export type MaintenanceCycleReport = CycleReport & { semantic: SemanticMaintenanceResult };

type CompletionApi = Pick<OpenClawPluginApi, "runtime">;
type CompletionRuntime = {
  config?: { current?: () => { agents?: { entries?: Record<string, unknown> } } };
  llm?: { complete?: (params: Record<string, unknown>) => Promise<unknown> };
  subagent?: { complete?: (params: Record<string, unknown>) => Promise<unknown> };
};

function hostAgentId(api: CompletionApi): string | undefined {
  const runtime = api.runtime as unknown as CompletionRuntime;
  const entries = runtime.config?.current?.()?.agents?.entries;
  const first = entries && typeof entries === "object" ? Object.keys(entries)[0] : undefined;
  return typeof first === "string" && first.trim() ? first.trim() : undefined;
}

function completionText(result: unknown): string {
  const text = typeof result === "string" ? result : (result as { text?: unknown } | undefined)?.text;
  if (typeof text !== "string" || !text.trim()) throw new Error("isolated completion returned no text");
  return text;
}

/** Both host APIs are tool-free, session-free and delivery-free; no agent-turn fallback. */
export function createIsolatedCompletion(api: CompletionApi, input: {
  agentId?: string;
  config?: unknown;
  signal?: AbortSignal;
} = {}): IsolatedCompletion | null {
  const runtime = api.runtime as unknown as CompletionRuntime;
  const ownerSignal = input.signal;
  const timeoutMs = 30_000;
  const agentId = input.agentId?.trim() || hostAgentId(api);
  const llm = runtime.llm?.complete;
  const subagent = runtime.subagent?.complete;
  if (!agentId) return null;
  const combine = (signal: AbortSignal): AbortSignal =>
    ownerSignal ? AbortSignal.any([ownerSignal, signal]) : signal;
  const call = (method: (params: Record<string, unknown>) => Promise<unknown>, owner: object, params: Record<string, unknown>) =>
    method.call(owner, params).then(completionText);
  const llmCall = typeof llm === "function"
    ? (request: Parameters<IsolatedCompletion>[0]) =>
        call(llm, runtime.llm!, {
          agentId,
          systemPrompt: request.systemPrompt,
          messages: [{ role: "user", content: request.message }],
          purpose: "people.semantic.maintenance",
          maxTokens: 1000,
          temperature: 0.1,
          signal: combine(request.signal),
          execution: { mode: "isolated-agent-runtime", timeoutMs },
        })
    : null;
  const subagentCall = typeof subagent === "function"
    ? (request: Parameters<IsolatedCompletion>[0]) =>
        call(subagent, runtime.subagent!, {
          agentId,
          message: request.message,
          extraSystemPrompt: request.systemPrompt,
          timeoutMs,
          signal: combine(request.signal),
        })
    : null;
  let preferred = llmCall;
  let secondary = subagentCall;
  if (!preferred) {
    preferred = secondary;
    secondary = null;
  }
  if (!preferred) return null;
  return async (request) => {
    if (ownerSignal?.aborted) throw new Error("maintenance aborted");
    if (preferred) {
      try {
        return await preferred(request);
      } catch (error) {
        if (!secondary) throw error;
      }
    }
    return secondary!(request);
  };
}

/** Count-only summary; no profile content or sender ids. */
export function describeMaintenance(summary: MaintenanceSummary): string {
  const semantic = summary.semantic;
  return [
    `health=${summary.healthOk ? "ok" : "error"}`,
    `backup=${summary.backup ? "yes" : "skip"}`,
    `repairs=${summary.repairActions}`,
    `semantic=${semantic.unavailable ? "unavailable" : semantic.compacted + "/" + semantic.processed}`,
    `failed=${semantic.failed}`,
    `remaining=${semantic.remaining}`,
    `durationMs=${summary.durationMs}`,
  ].join(" ");
}

export class PeopleRuntime {
  readonly api: OpenClawPluginApi;
  readonly config: PeoplePluginConfig;
  readonly identities = new IdentityStore();
  maintenanceService: MaintenanceServiceState | null = null;
  private readonly cache = new Map<string, PeopleService>();
  private readonly maintenanceLocks = new Set<string>();
  private readonly maintenanceReports = new Map<string, MaintenanceSummary>();
  private readonly maintenanceSummaryCache = new Map<string, MaintenanceSummary>();

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

  /** Persist service heartbeat in the workspace DB so CLI and Gateway agree. */
  markMaintenanceState(
    context: WorkspaceContext,
    patch: Partial<{
      startedAt: string | null;
      stoppedAt: string | null;
      intervalMs: number | null;
      scheduledAt: string | null;
      completedAt: string | null;
      lastSummary: string | null;
      lastError: string | null;
    }>,
  ): void {
    const service = this.get(context);
    for (const [name, value] of Object.entries(patch)) {
      const key = "people_service_" + name.replace(/[A-Z]/gu, (letter) => "_" + letter.toLowerCase());
      service.db.metaSet(key, value == null ? "" : String(value));
    }
  }

  /**
   * Plugin-owned evidence checks. Family conflicts have decisive identity proof;
   * duplicate display names and unlinked placeholder people are left untouched.
   */
  private resolveEvidenceDrivenMerges(service: PeopleService): string[] {
    const actions: string[] = [];
    for (const conflict of service.familyBindingConflicts()) {
      const persons = conflict.persons;
      if (persons.length < 2) continue;
      let targetId = persons[0]!;
      for (const personId of persons.slice(1)) {
        const target = service.db.getPerson(targetId);
        const candidate = service.db.getPerson(personId);
        if (!target || !candidate) continue;
        const targetNamed = Boolean(target.call_name || target.name);
        const candidateNamed = Boolean(candidate.call_name || candidate.name);
        if (!targetNamed && candidateNamed) {
          service.db.mergePersons(targetId, personId);
          targetId = personId;
          actions.push(`同族人物合并 ${targetId} → ${personId}`);
          continue;
        }
        service.db.mergePersons(personId, targetId);
        actions.push(`同族人物合并 ${personId} → ${targetId}`);
      }
      for (const row of conflict.rows) {
        service.db.bindAccount(row.account_id, targetId, { migrate: true });
      }
      actions.push(`同族绑定归一 ${conflict.rows.length} 行`);
    }
    return actions;
  }

  /** One maintenance host per distinct workspace root; main and orion share one. */
  resolveMaintenanceWorkspaces(input: {
    config?: unknown;
    workspaceDir?: string;
  } = {}): MaintenanceWorkspace[] {
    const config = (input.config ?? this.api.config) as Parameters<typeof resolveWorkspaceRoot>[0];
    const entries = (config as { agents?: { entries?: Record<string, unknown> } }).agents?.entries ?? {};
    const ids = Object.keys(entries).filter((id) => !isAgentDisabled(this.config, id));
    const hosts = new Map<string, MaintenanceWorkspace>();
    for (const agentId of ids) {
      const workspaceDir = resolveWorkspaceRoot(config, agentId);
      const key = resolveStorePaths({
        workspaceDir,
        agentId,
        stateDir: this.resolveStateDir(),
        config: this.config,
      }).workspaceKey;
      if (!hosts.has(key)) hosts.set(key, { workspaceDir, agentId });
    }
    return [...hosts.values()];
  }

  /** Deterministic maintenance plus bounded plugin-internal semantic compaction. */
  async runMaintenanceCycle(
    context: MaintenanceWorkspace,
    input: Parameters<PeopleService["cycle"]>[0] = {},
  ): Promise<MaintenanceCycleReport | null> {
    const service = this.get({ workspaceDir: context.workspaceDir, agentId: context.agentId });
    const key = service.paths.workspaceKey;
    if (this.maintenanceLocks.has(key)) return null;
    this.maintenanceLocks.add(key);
    const startedAt = Date.now();
    try {
      const report = service.cycle(input);
      let mergeActions: string[] = [];
      if (report.health.ok) {
        if (!report.health.lastBackupAt || isOlderThan(report.health.lastBackupAt, 24 * 3_600_000)) {
          this.api.logger.warn("[people] evidence merge skipped: no recent backup");
        } else {
          try {
            mergeActions = this.resolveEvidenceDrivenMerges(service);
          } catch (error) {
            this.api.logger.warn("[people] evidence merge skipped: " + (error instanceof Error ? error.message : String(error)));
          }
        }
      }
      let semantic: SemanticMaintenanceResult = {
        processed: 0,
        compacted: 0,
        failed: 0,
        unavailable: false,
        remaining: report.actions.filter((action) => action.kind === "compact").length,
      };
      try {
        const complete = createIsolatedCompletion(this.api, {
          agentId: context.agentId,
          config: (this.api.runtime as unknown as CompletionRuntime).config?.current?.(),
        });
        if (!complete) {
          semantic = { ...semantic, unavailable: true, reason: "isolated completion unavailable" };
        } else {
          semantic = await runSemanticMaintenance({
            service,
            actions: report.actions,
            complete,
            agentId: context.agentId,
            signal: AbortSignal.timeout(3 * 60_000),
            validateOk: report.health.ok,
            lastBackupAt: report.health.lastBackupAt,
          });
        }
      } catch (error) {
        semantic = {
          ...semantic,
          failed: semantic.failed + 1,
          reason: error instanceof Error ? error.message : String(error),
        };
      }
      const summary: MaintenanceSummary = {
        cycledAt: report.cycledAt,
        durationMs: Date.now() - startedAt,
        workspaceKey: key,
        repairActions: report.repairActions.length + mergeActions.length,
        backup: Boolean(report.backup),
        healthOk: report.health.ok,
        semantic,
      };
      this.maintenanceReports.set(key, summary);
      this.maintenanceSummaryCache.set(key, summary);
      try {
        service.db.metaSet("last_maintenance_summary", JSON.stringify(summary));
      } catch {
        // Observability must not fail the maintenance cycle.
      }
      if (this.config.debug) {
        this.api.logger.info(
          "[people] maintenance " + key.replace(/[^a-zA-Z0-9_-]/gu, "_") + " " + describeMaintenance(summary),
        );
      }
      return {
        ...report,
        repairActions: [...report.repairActions, ...mergeActions],
        health: service.health(),
        semantic,
      };
    } finally {
      this.maintenanceLocks.delete(key);
    }
  }

  maintenanceSummary(context: WorkspaceContext): MaintenanceSummary | null {
    const service = this.get(context);
    const key = service.paths.workspaceKey;
    const current = this.maintenanceReports.get(key);
    if (current) return current;
    const cached = this.maintenanceSummaryCache.get(key);
    if (cached) return cached;
    const persisted = service.db.metaGet("last_maintenance_summary");
    if (!persisted) return null;
    try {
      const parsed = JSON.parse(persisted) as MaintenanceSummary;
      if (!parsed?.cycledAt || typeof parsed.healthOk !== "boolean") return null;
      this.maintenanceSummaryCache.set(key, parsed);
      return parsed;
    } catch {
      return null;
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
    this.identities.clear();
    for (const service of this.cache.values()) {
      try {
        service.close();
      } catch {
        // ignore
      }
    }
    this.cache.clear();
    this.maintenanceReports.clear();
    this.maintenanceSummaryCache.clear();
  }
}
