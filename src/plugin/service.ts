import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { retireLegacyCycleCrons } from "./legacy-cron.js";
import type { LegacyCronApi } from "./legacy-cron.js";
import type { PeopleRuntime } from "./runtime.js";
import type { MaintenanceWorkspace } from "./runtime.js";

const CYCLE_INTERVAL_MS = 6 * 60 * 60_000;

/** Count-only diagnostics for the host-owned background scheduler. */
export type MaintenanceServiceState = {
  startedAt: string;
  intervalMs: number;
  scheduledAt: string | null;
  completedAt: string | null;
  lastSummary: string | null;
  lastError: string | null;
};

/** Explicit service state owned by PeopleRuntime; no hidden runtime property. */
export function readMaintenanceServiceState(runtime: PeopleRuntime): MaintenanceServiceState | null {
  return runtime.maintenanceService;
}

/** Gateway-owned background maintenance; no external automation is registered. */
export function registerMaintenanceService(api: OpenClawPluginApi, runtime: PeopleRuntime): void {
  if (typeof api.registerService !== "function") return;
  let startedHosts: MaintenanceWorkspace[] = [];
  const state: MaintenanceServiceState = {
    startedAt: new Date().toISOString(),
    intervalMs: CYCLE_INTERVAL_MS,
    scheduledAt: null,
    completedAt: null,
    lastSummary: null,
    lastError: null,
  };
  runtime.maintenanceService = state;
  api.registerService({
    id: "people-maintenance",
    apiVersion: 2,
    async start({ scheduler, serviceHealth, workspaceDir, config, getCron }) {
      runtime.maintenanceService = state;
      startedHosts = [];
      state.startedAt = new Date().toISOString();
      state.scheduledAt = null;
      state.completedAt = null;
      state.lastSummary = null;
      state.lastError = null;
      const cron = typeof getCron === "function" ? (getCron() as LegacyCronApi | undefined) : undefined;
      const hosts = runtime.resolveMaintenanceWorkspaces({ config, workspaceDir });
      const stateHosts = hosts.length > 0 ? hosts : workspaceDir ? [{ workspaceDir }] : [];
      const persistFailure = (message: string): void => {
        state.lastError = message;
        for (const host of stateHosts) {
          try {
            runtime.markMaintenanceState(host, { stoppedAt: state.startedAt, lastError: message });
          } catch {
            // The host health report still receives the failure even when the
            // workspace database itself cannot record it.
            api.logger.warn("[people] maintenance failure state could not be persisted for one workspace");
          }
        }
      };
      if (!scheduler) {
        const error = new Error("people-maintenance requires host scheduler (apiVersion 2)");
        serviceHealth?.reportFailure?.(error);
        persistFailure(error.message);
        throw error;
      }
      startedHosts = hosts;
      if (hosts.length === 0) {
        api.logger.warn("[people] maintenance disabled: no enabled workspace agents");
        persistFailure("no enabled workspace agents");
        return;
      }
      api.logger.info(`[people] maintenance service started for ${hosts.length} workspace(s)`);
      await retireLegacyCycleCrons(cron ? () => cron : undefined, api);
      try {
        for (const host of hosts) {
          runtime.markMaintenanceState(host, {
            startedAt: state.startedAt,
            stoppedAt: null,
            intervalMs: CYCLE_INTERVAL_MS,
            lastError: null,
          });
        }
        scheduler.schedule({
          id: "people-cycle",
          delayMs: 30_000,
          everyMs: CYCLE_INTERVAL_MS,
          mode: "replace",
          run: async () => {
            if (scheduler.signal.aborted) return;
            state.scheduledAt = new Date().toISOString();
            state.lastSummary = null;
            const failedHosts = new Set<MaintenanceWorkspace>();
            const skippedHosts = new Set<MaintenanceWorkspace>();
            const recordFailure = (host: MaintenanceWorkspace, message: string): void => {
              failedHosts.add(host);
              state.lastError = message;
              try {
                runtime.markMaintenanceState(host, { lastError: message });
              } catch {
                api.logger.warn("[people] maintenance failure state could not be persisted for one workspace");
              }
            };
            for (const host of hosts) {
              if (scheduler.signal.aborted) return;
              try {
                runtime.markMaintenanceState(host, { scheduledAt: state.scheduledAt });
              } catch (error) {
                recordFailure(host, error instanceof Error ? error.message : String(error));
              }
            }
            for (const host of hosts) {
              if (failedHosts.has(host)) continue;
              if (scheduler.signal.aborted) return;
              try {
                const result = await runtime.runMaintenanceCycle(host, {}, scheduler.signal);
                if (!result) {
                  if (scheduler.signal.aborted) return;
                  skippedHosts.add(host);
                  continue;
                }
                if (!result.health.ok) {
                  throw new Error("maintenance health check failed");
                }
                if (result.semantic.failed > 0) {
                  throw new Error("internal semantic maintenance failed");
                }
              } catch (error) {
                if (scheduler.signal.aborted) return;
                recordFailure(host, error instanceof Error ? error.message : String(error));
                api.logger.warn("[people] maintenance cycle failed for one workspace");
              }
            }
            if (scheduler.signal.aborted) return;
            const completedAt = new Date().toISOString();
            const completedHosts = hosts.filter(
              (host) => !failedHosts.has(host) && !skippedHosts.has(host),
            );
            const summary = completedHosts
              .map((host) => runtime.maintenanceSummary(host))
              .filter((item): item is NonNullable<typeof item> => Boolean(item))
              .map((item) => `${item.workspaceKey}:${item.healthOk ? "ok" : "error"}`)
              .join(",");
            for (const host of hosts) {
              if (scheduler.signal.aborted) return;
              if (!completedHosts.includes(host)) continue;
              try {
                runtime.markMaintenanceState(host, {
                  completedAt,
                  lastSummary: summary,
                  lastError: null,
                });
              } catch (error) {
                recordFailure(host, error instanceof Error ? error.message : String(error));
                api.logger.warn("[people] maintenance completion state could not be persisted for one workspace");
              }
            }
            if (scheduler.signal.aborted) return;
            if (failedHosts.size === 0 && skippedHosts.size === 0) {
              state.completedAt = completedAt;
              state.lastError = null;
              state.lastSummary = summary;
            }
            if (failedHosts.size > 0) {
              serviceHealth?.reportFailure?.(
                new Error(`people maintenance failed for ${failedHosts.size}/${hosts.length} workspace(s)`),
              );
            } else {
              serviceHealth?.clearFailure?.();
            }
          },
        });
      } catch (error) {
        const failure = error instanceof Error ? error : new Error(String(error));
        persistFailure(failure.message);
        serviceHealth?.reportFailure?.(failure);
        throw failure;
      }
    },
    stop() {
      for (const host of startedHosts) {
        try {
          runtime.markMaintenanceState(host, { stoppedAt: new Date().toISOString() });
        } catch {
          api.logger.warn("[people] maintenance stop state could not be persisted for one workspace");
        }
      }
      runtime.maintenanceService = null;
      runtime.closeAll();
    },
  });
}
