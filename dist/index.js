import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { registerCli } from "./src/plugin/cli.js";
import { registerHooks } from "./src/plugin/hooks.js";
import { PeopleRuntime } from "./src/plugin/runtime.js";
import { registerMaintenanceService } from "./src/plugin/service.js";
import { registerTools } from "./src/plugin/tools.js";
export default definePluginEntry({
    id: "people",
    name: "People Memory",
    description: "Workspace-scoped people and group memory backed by SQLite.",
    register(api) {
        const runtime = new PeopleRuntime(api);
        registerTools(api, runtime);
        registerHooks(api, runtime);
        registerMaintenanceService(api, runtime);
        registerCli(api, runtime);
        api.logger.info("[people] registered tools, hooks and workspace maintenance service");
    },
});
