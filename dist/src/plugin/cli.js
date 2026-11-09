import { resolveWorkspaceRoot } from "../core/paths.js";
import { describeCounts } from "../core/service.js";
function printJson(value) {
    process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}
function describeCapture(capture) {
    return `采集心跳: ${capture.lastAt ?? "无"}; 标准 ${capture.standardCount}; hex 回退 ${capture.sessionFallbackCount}; 挂起 ${capture.deferredCount}`;
}
function workspaceFor(api, options) {
    const agentId = typeof options.agent === "string" ? options.agent : undefined;
    const workspaceDir = (typeof options.workspace === "string" && options.workspace.trim()) ||
        resolveWorkspaceRoot(api.config, agentId);
    return { workspaceDir, agentId };
}
export function registerCli(api, runtime) {
    if (typeof api.registerCli !== "function")
        return;
    api.registerCli(({ program }) => {
        const people = program.command("people").description("Workspace-scoped people memory utilities");
        people
            .command("import")
            .description("Re-import legacy JSON into the SQLite store (idempotent)")
            .option("--workspace <path>", "Target workspace directory")
            .option("--agent <id>", "Resolve workspace from an agent id")
            .option("--force", "Re-import even if legacy data was imported before")
            .option("--json", "Print JSON")
            .action(async (options = {}) => {
            const { workspaceDir, agentId } = workspaceFor(api, options);
            const service = runtime.get({ workspaceDir, agentId });
            const report = service.importLegacy(options.force === true);
            if (options.json)
                return printJson(report);
            console.log(`导入: ${report.imported ? "完成" : "跳过"}${report.reason ? `（${report.reason}）` : ""}`);
            console.log(`账号 ${report.accounts} · 人物 ${report.persons} · 绑定 ${report.bindings} · 群 ${report.groups} · 群记忆 ${report.groupEvents} · 印象 ${report.impressions} · 特征 ${report.traits}`);
            if (report.warnings.length > 0)
                console.log(`警告 ${report.warnings.length} 条`);
        });
        people
            .command("status")
            .description("Show people database status")
            .option("--workspace <path>", "Target workspace directory")
            .option("--agent <id>", "Resolve workspace from an agent id")
            .option("--json", "Print JSON")
            .action(async (options = {}) => {
            const { workspaceDir, agentId } = workspaceFor(api, options);
            const service = runtime.get({ workspaceDir, agentId });
            const status = service.status();
            if (options.json)
                return printJson(status);
            console.log(`工作区: ${status.workspaceDir}`);
            console.log(`数据目录: ${status.dataDir}`);
            console.log(`数据库: ${status.dbPath} (schema v${status.schemaVersion})`);
            console.log(describeCounts(status.counts));
            console.log(`最近全量扫描: ${status.lastFullScanAt ?? "无"}`);
            console.log(`旧 JSON 导入: ${status.legacyImportedAt ?? "无"}`);
            console.log(describeCapture(status.capture));
            const svc = status.maintenance;
            console.log(svc
                ? `后台维护: ${svc.active ? "运行中" : "未运行"}; 启动 ${svc.startedAt ?? "无"}; 最近调度 ${svc.scheduledAt ?? "无"}; 最近完成 ${svc.completedAt ?? "无"}; 最近失败 ${svc.lastError ?? "无"}`
                : "后台维护: 无状态");
            console.log(`授权链: owner 只认宿主本轮 senderIsOwner=true; 写入工具: ${status.security.writeTools ? "开" : "关"}`);
        });
        people
            .command("validate")
            .description("Validate people database integrity")
            .option("--workspace <path>", "Target workspace directory")
            .option("--agent <id>", "Resolve workspace from an agent id")
            .option("--fix", "Repair safe issues")
            .option("--json", "Print JSON")
            .action(async (options = {}) => {
            const { workspaceDir, agentId } = workspaceFor(api, options);
            const service = runtime.get({ workspaceDir, agentId });
            const actions = options.fix ? service.repair() : [];
            const report = service.validate();
            if (options.json)
                return printJson({ ...report, repairActions: actions });
            console.log(`${report.ok ? "OK" : "FAIL"} ${report.dbPath}`);
            console.log(describeCounts(report.counts));
            for (const issue of report.issues)
                console.log(`[${issue.level}] ${issue.code}: ${issue.message}`);
            for (const action of actions)
                console.log(`[fix] ${action}`);
        });
        people
            .command("bootstrap")
            .description("Create the database and import legacy JSON when present")
            .option("--workspace <path>", "Target workspace directory")
            .option("--agent <id>", "Resolve workspace from an agent id")
            .option("--json", "Print JSON")
            .action(async (options = {}) => {
            const { workspaceDir, agentId } = workspaceFor(api, options);
            const status = runtime.get({ workspaceDir, agentId }).status();
            if (options.json)
                return printJson(status);
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
            .action(async (options = {}) => {
            const { workspaceDir, agentId } = workspaceFor(api, options);
            const keep = options.keep ? Number(options.keep) : 14;
            const report = runtime.get({ workspaceDir, agentId }).backup(keep);
            if (options.json)
                return printJson(report);
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
            .action(async (options = {}) => {
            const { workspaceDir, agentId } = workspaceFor(api, options);
            const report = runtime.get({ workspaceDir, agentId }).health();
            if (options.json)
                return printJson(report);
            console.log(`${report.ok ? "OK" : "FAIL"} ${report.dbPath}`);
            console.log(`最近备份: ${report.lastBackupAt ?? "无"}`);
            console.log(describeCapture(report.capture));
            console.log(describeCounts(report.counts));
            for (const issue of report.issues)
                console.log(`[${issue.level}] ${issue.code}: ${issue.message}`);
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
            .action(async (options = {}) => {
            const { workspaceDir, agentId } = workspaceFor(api, options);
            const report = await runtime.runMaintenanceCycle({ workspaceDir, agentId }, {
                backupKeep: options.keep ? Number(options.keep) : 14,
                backupIntervalHours: options.intervalHours ? Number(options.intervalHours) : 20,
                forceBackup: options.forceBackup === true,
            });
            if (!report) {
                console.log("本工作区已有维护轮次在执行，本轮跳过。");
                return;
            }
            if (options.json)
                return printJson(report);
            console.log(`周期: ${report.cycledAt}`);
            console.log(report.backup ? `备份: ${report.backup.dbBackup}` : "备份: 跳过");
            console.log(`自动修复: ${report.repairActions.length ? report.repairActions.join("；") : "无"}`);
            console.log(`健康: ${report.health.ok ? "ok" : "error"}，待办 ${report.actions.length} 项`);
            console.log(`内部语义压缩: ${report.semantic.unavailable ? "不可用，原文保留" : `完成 ${report.semantic.compacted}/${report.semantic.processed}`}; 失败 ${report.semantic.failed}; 剩余 ${report.semantic.remaining}`);
            if (runtime.config.debug) {
                for (const action of report.actions)
                    console.log(`[${action.kind}] ${action.target}: ${action.message}`);
            }
        });
        people
            .command("search")
            .description("Search accounts, persons, impressions and group events")
            .option("--query <text>", "Search text")
            .option("--workspace <path>", "Target workspace directory")
            .option("--agent <id>", "Resolve workspace from an agent id")
            .option("--limit <n>", "Maximum hits per section")
            .option("--json", "Print JSON")
            .action(async (options = {}) => {
            if (!options.query?.trim())
                throw new Error("--query is required");
            const { workspaceDir, agentId } = workspaceFor(api, options);
            const limit = options.limit ? Number(options.limit) : 10;
            const report = runtime.get({ workspaceDir, agentId }).search(options.query, limit);
            if (options.json)
                return printJson(report);
            console.log(`账号 ${report.accounts.length} · 人物 ${report.persons.length} · 印象 ${report.impressions.length} · 群事件 ${report.groupEvents.length}`);
            for (const account of report.accounts)
                console.log(`账号 ${account.account_id} (${account.display_name ?? "?"})`);
            for (const person of report.persons)
                console.log(`人物 ${person.person_id} (${person.name ?? "?"})`);
            for (const impression of report.impressions)
                console.log(`印象 ${impression.owner_id}: ${impression.content}`);
            for (const event of report.groupEvents)
                console.log(`群事件 ${event.group_id}: ${event.summary}`);
        });
    }, { commands: ["people"] });
}
