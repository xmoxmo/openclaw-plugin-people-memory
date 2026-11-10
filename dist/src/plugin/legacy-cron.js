const LEGACY_CYCLE_JOB_NAMES = new Set([
    "person-scan-wind",
    "person-scan-rain",
    "people-cycle-home",
    "people-cycle-public",
    "people-cycle",
    "people-cycle-orion",
    "people-scan-orion",
    "people-scan-public",
]);
function declaredPayload(job) {
    const payload = job.payload;
    if (!payload || typeof payload !== "object")
        return "";
    try {
        return JSON.stringify(payload);
    }
    catch {
        return "";
    }
}
function isPluginOwnedCycleJob(job) {
    const name = job.name?.trim() ?? "";
    if (!name || !job.id)
        return false;
    const description = job.description?.trim() ?? "";
    const declaration = job.declarationKey?.trim() ?? "";
    const payload = declaredPayload(job);
    if (LEGACY_CYCLE_JOB_NAMES.has(name))
        return true;
    if (declaration.startsWith("people:") &&
        /people_(cycle|scan)|识人周期|识人扫描/u.test(description + "\n" + payload))
        return true;
    if (!/^people-(cycle|scan)[-_]/iu.test(name))
        return false;
    return /people_(cycle|scan)|识人周期执行员/u.test(payload);
}
/** Remove retired prompt-driven cron jobs during service startup; never touch other jobs. */
export async function retireLegacyCycleCrons(getCron, api) {
    if (typeof getCron !== "function")
        return 0;
    let removed = 0;
    try {
        const cron = getCron();
        if (!cron)
            return 0;
        const jobs = await cron.list({ includeDisabled: true });
        const peopleOwnedJobs = jobs.filter(isPluginOwnedCycleJob);
        for (const job of peopleOwnedJobs) {
            if (!job.id)
                continue;
            try {
                await cron.remove(job.id);
                removed += 1;
            }
            catch {
                api.logger.warn("[people] retired cron cleanup skipped for one plugin-owned job");
            }
        }
        if (removed > 0)
            api.logger.info("[people] removed " + removed + " retired external cycle cron job(s)");
    }
    catch {
        api.logger.warn("[people] retired cron cleanup unavailable");
    }
    return removed;
}
