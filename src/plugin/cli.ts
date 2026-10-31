import path from "node:path";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { resolveWorkspaceRoot } from "../core/paths.js";
import { describeCounts } from "../core/service.js";
import type { PeopleRuntime } from "./runtime.js";

type CliProgram = {
  command: (name: string) => CliProgram;
  description: (text: string) => CliProgram;
  option: (flags: string, description?: string) => CliProgram;
  action: (handler: (options?: Record<string, unknown>) => Promise<void> | void) => CliProgram;
};

type CliOptions = {
  workspace?: string;
  agent?: string;
  json?: boolean;
  fix?: boolean;
  force?: boolean;
  to?: string;
  keep?: string;
  query?: string;
  limit?: string;
  intervalHours?: string;
  forceBackup?: boolean;
};

function printJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function workspaceFor(api: OpenClawPluginApi, options: CliOptions): { workspaceDir: string; agentId?: string } {
  const agentId = typeof options.agent === "string" ? options.agent : undefined;
  const workspaceDir =
    (typeof options.workspace === "string" && options.workspace.trim()) ||
    resolveWorkspaceRoot(
      api.config as Parameters<typeof resolveWorkspaceRoot>[0],
      agentId,
    );
  return { workspaceDir, agentId };
}

export function registerCli(api: OpenClawPluginApi, runtime: PeopleRuntime): void {
  if (typeof api.registerCli !== "function") return;
  api.registerCli(
    ({ program }: { program: CliProgram }) => {
      const people = program.command("people").description("Workspace-scoped people memory utilities");

      people
        .command("import")
        .description("Re-import legacy JSON into the SQLite store (idempotent)")
        .option("--workspace <path>", "Target workspace directory")
        .option("--agent <id>", "Resolve workspace from an agent id")
        .option("--force", "Re-import even if legacy data was imported before")
        .option("--json", "Print JSON")
        .action(async (options: CliOptions = {}) => {
          const { workspaceDir, agentId } = workspaceFor(api, options);
          const service = runtime.get({ workspaceDir, agentId });
          const report = service.importLegacy(options.force === true);
          if (options.json) return printJson(report);
          console.log(`导入: ${report.imported ? "完成" : "跳过"}${report.reason ? `（${report.reason}）` : ""}`);
          console.log(
            `账号 ${report.accounts} · 人物 ${report.persons} · 绑定 ${report.bindings} · 群 ${report.groups} · 群记忆 ${report.groupEvents} · 印象 ${report.impressions} · 特征 ${report.traits}`,
          );
          if (report.warnings.length > 0) console.log(`警告 ${report.warnings.length} 条`);
        });

      people
        .command("status")
        .description("Show people database status")
        .option("--workspace <path>", "Target workspace directory")
        .option("--agent <id>", "Resolve workspace from an agent id")
        .option("--json", "Print JSON")
        .action(async (options: CliOptions = {}) => {
          const { workspaceDir, agentId } = workspaceFor(api, options);
          const service = runtime.get({ workspaceDir, agentId });
          const status = service.status();
          if (options.json) return printJson(status);
          console.log(`工作区: ${status.workspaceDir}`);
          console.log(`数据目录: ${status.dataDir}`);
          console.log(`数据库: ${status.dbPath} (schema v${status.schemaVersion})`);
          console.log(describeCounts(status.counts));
          console.log(`最近全量扫描: ${status.lastFullScanAt ?? "无"}`);
          console.log(`旧 JSON 导入: ${status.legacyImportedAt ?? "无"}`);
        });

      people
        .command("validate")
        .description("Validate people database integrity")
        .option("--workspace <path>", "Target workspace directory")
        .option("--agent <id>", "Resolve workspace from an agent id")
        .option("--fix", "Repair safe issues")
        .option("--json", "Print JSON")
        .action(async (options: CliOptions = {}) => {
          const { workspaceDir, agentId } = workspaceFor(api, options);
          const service = runtime.get({ workspaceDir, agentId });
          const actions = options.fix ? service.repair() : [];
          const report = service.validate();
          if (options.json) return printJson({ ...report, repairActions: actions });
          console.log(`${report.ok ? "OK" : "FAIL"} ${report.dbPath}`);
          console.log(describeCounts(report.counts));
          for (const issue of report.issues) console.log(`[${issue.level}] ${issue.code}: ${issue.message}`);
          for (const action of actions) console.log(`[fix] ${action}`);
        });

      people
        .command("bootstrap")
        .description("Create the database and import legacy JSON when present")
        .option("--workspace <path>", "Target workspace directory")
        .option("--agent <id>", "Resolve workspace from an agent id")
        .option("--json", "Print JSON")
        .action(async (options: CliOptions = {}) => {
          const { workspaceDir, agentId } = workspaceFor(api, options);
          const status = runtime.get({ workspaceDir, agentId }).status();
          if (options.json) return printJson(status);
          console.log(`已初始化: ${status.dbPath}`);
          console.log(describeCounts(status.counts));
          console.log(`旧 JSON 导入: ${status.legacyImportedAt ?? "无"}`);
        });

      people
        .command("backup")
        .description("Back up the SQLite store and export a JSON snapshot")
        .option("--workspace <path>", "Target workspace directory")
        .option("--agent <id>", "Resolve workspace from an agent id")
        .option("--keep <n>", "Number of recent backup pairs to retain")
        .option("--json", "Print JSON")
        .action(async (options: CliOptions = {}) => {
          const { workspaceDir, agentId } = workspaceFor(api, options);
          const keep = options.keep ? Number(options.keep) : 14;
          const report = runtime.get({ workspaceDir, agentId }).backup(keep);
          if (options.json) return printJson(report);
          console.log(`备份目录: ${report.backupDir}`);
          console.log(`SQLite: ${report.dbBackup} (${report.dbBytes} bytes)`);
          console.log(`JSON: ${report.jsonBackup} (${report.jsonBytes} bytes)`);
          console.log(`保留 ${report.kept} 份，清理旧文件 ${report.removedOld} 个`);
        });

      people
        .command("health")
        .description("Check maintenance risks without changing data")
        .option("--workspace <path>", "Target workspace directory")
        .option("--agent <id>", "Resolve workspace from an agent id")
        .option("--json", "Print JSON")
        .action(async (options: CliOptions = {}) => {
          const { workspaceDir, agentId } = workspaceFor(api, options);
          const report = runtime.get({ workspaceDir, agentId }).health();
          if (options.json) return printJson(report);
          console.log(`${report.ok ? "OK" : "FAIL"} ${report.dbPath}`);
          console.log(`最近备份: ${report.lastBackupAt ?? "无"}`);
          console.log(describeCounts(report.counts));
          for (const issue of report.issues) console.log(`[${issue.level}] ${issue.code}: ${issue.message}`);
        });

      people
        .command("cycle")
        .description("Run one plugin-owned maintenance cycle")
        .option("--workspace <path>", "Target workspace directory")
        .option("--agent <id>", "Resolve workspace from an agent id")
        .option("--keep <n>", "Number of recent backup pairs to retain")
        .option("--interval-hours <n>", "Minimum hours between automatic backups")
        .option("--force-backup", "Create a backup even when one is recent")
        .option("--json", "Print JSON")
        .action(async (options: CliOptions = {}) => {
          const { workspaceDir, agentId } = workspaceFor(api, options);
          const report = runtime.get({ workspaceDir, agentId }).cycle({
            backupKeep: options.keep ? Number(options.keep) : 14,
            backupIntervalHours: options.intervalHours ? Number(options.intervalHours) : 20,
            forceBackup: options.forceBackup === true,
          });
          if (options.json) return printJson(report);
          console.log(`周期: ${report.cycledAt}`);
          console.log(report.backup ? `备份: ${report.backup.dbBackup}` : "备份: 跳过");
          console.log(`自动修复: ${report.repairActions.length ? report.repairActions.join("；") : "无"}`);
          console.log(`健康: ${report.health.ok ? "ok" : "error"}，待办 ${report.actions.length} 项`);
          for (const action of report.actions) console.log(`[${action.kind}] ${action.target}: ${action.message}`);
        });

      people
        .command("search")
        .description("Search accounts, persons, impressions and group events")
        .option("--query <text>", "Search text")
        .option("--workspace <path>", "Target workspace directory")
        .option("--agent <id>", "Resolve workspace from an agent id")
        .option("--limit <n>", "Maximum hits per section")
        .option("--json", "Print JSON")
        .action(async (options: CliOptions = {}) => {
          if (!options.query?.trim()) throw new Error("--query is required");
          const { workspaceDir, agentId } = workspaceFor(api, options);
          const limit = options.limit ? Number(options.limit) : 10;
          const report = runtime.get({ workspaceDir, agentId }).search(options.query, limit);
          if (options.json) return printJson(report);
          console.log(`账号 ${report.accounts.length} · 人物 ${report.persons.length} · 印象 ${report.impressions.length} · 群事件 ${report.groupEvents.length}`);
          for (const account of report.accounts) console.log(`账号 ${account.account_id} (${account.display_name ?? "?"})`);
          for (const person of report.persons) console.log(`人物 ${person.person_id} (${person.name ?? "?"})`);
          for (const impression of report.impressions) console.log(`印象 ${impression.owner_id}: ${impression.content}`);
          for (const event of report.groupEvents) console.log(`群事件 ${event.group_id}: ${event.summary}`);
        });
    },
    { commands: ["people"] },
  );
}
