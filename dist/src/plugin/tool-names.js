/** Exact People tool names; also used as the host tool-hook matcher. */
export const PEOPLE_TOOL_NAMES = [
    "people_status",
    "people_lookup",
    "people_remember",
    "people_name",
    "people_note",
    "people_bot_hint",
    "people_bind",
    "people_forget",
    "people_validate",
    "people_scan_mark",
    "people_bootstrap",
    "people_backup",
    "people_health",
    "people_cycle",
    "people_search",
    "people_dimension",
    "people_merge",
    "people_merge_account",
    "people_unbind",
];
const PEOPLE_TOOL_NAME_SET = new Set(PEOPLE_TOOL_NAMES);
export function isPeopleToolName(value) {
    return PEOPLE_TOOL_NAME_SET.has(value);
}
