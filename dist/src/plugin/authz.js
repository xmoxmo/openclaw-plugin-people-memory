/** A turn without a trusted requester sender is an internal/system turn. */
export function isInternalTurn(ctx) {
    return !ctx.requesterSenderId?.trim();
}
/**
 * Internal turns keep the historical privileged behavior unless the operator
 * opts into strict mode with `internalAdminAgents`. Once that list is set (even
 * to an empty array), only listed agent ids may act as internal admins. This
 * closes the gap where a public gateway run also has no requester sender.
 */
export function isInternalAdmin(ctx, config) {
    if (!isInternalTurn(ctx))
        return false;
    const allow = config.internalAdminAgents;
    if (allow === undefined)
        return true;
    const agentId = ctx.agentId?.trim();
    return Boolean(agentId && allow.includes(agentId));
}
export function canManage(ctx, config) {
    return ctx.senderIsOwner === true || isInternalAdmin(ctx, config);
}
/** Write tools default to on; operators can turn them off explicitly. */
export function writeToolsEnabled(config) {
    return config.writeTools !== false;
}
/** Whether a resolved group is the conversation the caller is currently in. */
export function groupMatchesCurrent(group, current) {
    const value = current?.trim();
    if (!value)
        return false;
    return (group.chat_id === value ||
        group.group_id === value ||
        group.group_id.endsWith(`:${value}`));
}
