/** Saved role is display metadata, not a lookup into the current role catalog. */
export function formatTaskletLabel(identity: { taskletId?: string; title: string; role?: string }): string {
	const role = identity.role ? ` (${identity.role})` : ""
	return identity.taskletId ? `${identity.taskletId}${role} — ${identity.title}` : `${identity.title}${role}`
}
