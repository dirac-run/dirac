import path from "node:path"
import type {
	CommandApprovalIdentity,
	CommandApprovalRequest,
	CommandApprovalsCapability,
	CommandGrantSnapshot,
} from "./tools/interfaces/CommandApprovals"

function identityKey(identity: CommandApprovalIdentity): string {
	return identity.kind === "command"
		? JSON.stringify([identity.kind, identity.cwd, identity.command])
		: JSON.stringify([identity.kind, identity.cwd, identity.interpreter, identity.script])
}

function isIdentity(value: unknown): value is CommandApprovalIdentity {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false
	const identity = value as Record<string, unknown>
	if (typeof identity.cwd !== "string" || !path.isAbsolute(identity.cwd)) return false
	if (identity.kind === "command") {
		return Object.keys(identity).length === 3 && typeof identity.command === "string" && !!identity.command.trim()
	}
	return identity.kind === "script" && Object.keys(identity).length === 4 &&
		typeof identity.script === "string" && !!identity.script.trim() &&
		typeof identity.interpreter === "string" && !!identity.interpreter.trim()
}

/** Missing historical snapshots are handled by callers; malformed authority must never become empty. */
export function isCommandGrantSnapshot(value: unknown): value is CommandGrantSnapshot {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false
	const snapshot = value as Record<string, unknown>
	if (Object.keys(snapshot).length !== 2 || snapshot.version !== 1 || !Array.isArray(snapshot.grants)) return false
	const seen = new Set<string>()
	return snapshot.grants.every((grant: unknown) => {
		if (!grant || typeof grant !== "object" || Array.isArray(grant)) return false
		const entry = grant as Record<string, unknown>
		if (Object.keys(entry).length !== 2 || !isIdentity(entry.identity) || !Array.isArray(entry.restrictions) ||
			!entry.restrictions.every((item: unknown) => typeof item === "string")) return false
		const key = identityKey(entry.identity)
		if (seen.has(key)) return false
		seen.add(key)
		return true
	})
}

/** Root-owned, per-child serialization; only committed snapshots can satisfy a later call. */
export class TaskletCommandApprovals implements CommandApprovalsCapability {
	private committed: CommandGrantSnapshot
	private pending: Promise<unknown> = Promise.resolve()

	constructor(
		initial: CommandGrantSnapshot | undefined,
		private readonly persist: (snapshot: CommandGrantSnapshot) => Promise<void>,
		private readonly restrictions: (command: string) => readonly string[],
		private readonly assertActive: () => void,
		private readonly onReuse?: (count: number) => void,
	) {
		if (initial !== undefined && !isCommandGrantSnapshot(initial)) throw new Error("Invalid command grant snapshot")
		this.committed = structuredClone(initial ?? { version: 1, grants: [] })
	}

	authorize(requests: readonly CommandApprovalRequest[], approve: (missing: readonly number[]) => Promise<boolean>): Promise<boolean> {
		const inputs = structuredClone(requests)
		const result = this.pending.then(() => this.authorizeSerial(inputs, approve), () => this.authorizeSerial(inputs, approve))
		this.pending = result
		return result
	}

	assertCurrent(requests: readonly CommandApprovalRequest[]): void {
		this.assertActive()
		for (const request of requests) {
			this.validateRequest(request)
			if (!this.covers(request)) throw new Error("Command approval no longer covers the current restrictions")
		}
	}

	private validateRequest(request: CommandApprovalRequest): void {
		if (!request || !isIdentity(request.identity) || typeof request.effectiveCommand !== "string" || !request.effectiveCommand.trim()) {
			throw new Error("Invalid command approval request")
		}
	}

	private covers(request: CommandApprovalRequest): boolean {
		const current = this.restrictions(request.effectiveCommand)
		const key = identityKey(request.identity)
		const grant = this.committed.grants.find((entry) => identityKey(entry.identity) === key)
		return !!grant && current.every((restriction) => grant.restrictions.includes(restriction))
	}

	private async authorizeSerial(requests: readonly CommandApprovalRequest[], approve: (missing: readonly number[]) => Promise<boolean>): Promise<boolean> {
		this.assertActive()
		const missing: number[] = []
		const contexts = requests.map((request, index) => {
			this.validateRequest(request)
			if (!this.covers(request)) missing.push(index)
			return [...this.restrictions(request.effectiveCommand)]
		})
		if (requests.length > missing.length) this.onReuse?.(requests.length - missing.length)
		if (!missing.length) return true
		if (!await approve(missing)) return false
		this.assertActive()
		for (const index of missing) {
			if (this.restrictions(requests[index].effectiveCommand).some((restriction) => !contexts[index].includes(restriction))) {
				throw new Error("Command restrictions changed during approval")
			}
		}
		const next = structuredClone(this.committed)
		for (const index of missing) {
			const identity = requests[index].identity
			const previous = next.grants.findIndex((entry) => identityKey(entry.identity) === identityKey(identity))
			const grant = { identity: structuredClone(identity), restrictions: contexts[index] }
			if (previous < 0) next.grants.push(grant)
			else next.grants[previous] = grant
		}
		await this.persist(next)
		this.committed = next
		this.assertCurrent(requests)
		return true
	}
}
