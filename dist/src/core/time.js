function pad(value) {
    return String(value).padStart(2, "0");
}
/** Local ISO timestamp with an explicit offset, matching the legacy data style. */
export function nowIso(date = new Date()) {
    const offsetMinutes = -date.getTimezoneOffset();
    const sign = offsetMinutes >= 0 ? "+" : "-";
    const abs = Math.abs(offsetMinutes);
    return (`${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
        `T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}` +
        `${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`);
}
export function dayKey(value = new Date()) {
    if (value instanceof Date) {
        return `${value.getFullYear()}-${pad(value.getMonth() + 1)}-${pad(value.getDate())}`;
    }
    const match = /^(\d{4}-\d{2}-\d{2})/.exec(value);
    return match?.[1] ?? value.slice(0, 10);
}
export function isOlderThan(value, milliseconds) {
    if (!value)
        return true;
    const parsed = Date.parse(value);
    if (!Number.isFinite(parsed))
        return true;
    return Date.now() - parsed > milliseconds;
}
