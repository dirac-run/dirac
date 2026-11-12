/** Roles decorate display labels only; routing continues to use the raw ID. */
export function formatAgentLabel(identity: { id: string; role?: string }): string {
	const role = identity.id !== "Dirac" && identity.role && identity.role.toLowerCase() !== "default"
		? ` [${identity.role}]`
		: ""
	return `${identity.id}${role}`
}

/** Saved role is display metadata, not a lookup into the current role catalog. */
export function formatTaskletLabel(identity: { taskletId?: string; title: string; role?: string }): string {
	const label = formatAgentLabel({ id: identity.taskletId ?? identity.title, role: identity.role })
	return identity.taskletId ? `${label} — ${identity.title}` : label
}
