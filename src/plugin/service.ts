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
      const cron = typeof getCron === "function" ? (getCron() as LegacyCronApi | undefined) : undefined;
      const hosts = runtime.resolveMaintenanceWorkspaces({ config, workspaceDir });
      const stateHosts = hosts.length > 0 ? hosts : workspaceDir ? [{ workspaceDir }] : [];
      const persistFailure = (message: string): void => {
        state.lastError = message;
        for (const host of stateHosts) {
          runtime.markMaintenanceState(host, { stoppedAt: state.startedAt, lastError: message });
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
          state.scheduledAt = new Date().toISOString();
          for (const host of hosts) {
            runtime.markMaintenanceState(host, { scheduledAt: state.scheduledAt });
          }
          try {
            for (const host of hosts) {
              if (scheduler.signal.aborted) return;
              await runtime.runMaintenanceCycle(host);
            }
            state.completedAt = new Date().toISOString();
            state.lastError = null;
            state.lastSummary = hosts
              .map((host) => runtime.maintenanceSummary(host))
              .filter((summary): summary is NonNullable<typeof summary> => Boolean(summary))
              .map((summary) => `${summary.workspaceKey}:${summary.healthOk ? "ok" : "error"}`)
              .join(",");
            for (const host of hosts) {
              runtime.markMaintenanceState(host, {
                completedAt: state.completedAt,
                lastSummary: state.lastSummary,
                lastError: null,
              });
            }
            serviceHealth?.clearFailure?.();
          } catch (error) {
            state.lastError = error instanceof Error ? error.message : String(error);
            for (const host of hosts) {
              runtime.markMaintenanceState(host, { lastError: state.lastError });
            }
            api.logger.warn(`[people] maintenance cycle failed: ${state.lastError}`);
            serviceHealth?.reportFailure?.(error);
            throw error;
          }
        },
      });
    },
    stop() {
      for (const host of startedHosts) {
        runtime.markMaintenanceState(host, { stoppedAt: new Date().toISOString() });
      }
      runtime.maintenanceService = null;
      runtime.closeAll();
    },
  });
}
