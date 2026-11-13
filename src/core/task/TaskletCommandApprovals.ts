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

/** One-shot consent bound to invocation requests; historical exact-command grants are never reused. */
export class TaskletCommandApprovals implements CommandApprovalsCapability {
	private readonly approvals = new WeakMap<CommandApprovalRequest, { identity: string; effectiveCommand: string; restrictions: readonly string[] }>()

	constructor(
		initial: CommandGrantSnapshot | undefined,
		private readonly restrictions: (command: string) => readonly string[],
		private readonly assertActive: () => void,
	) {
		if (initial !== undefined && !isCommandGrantSnapshot(initial)) throw new Error("Invalid command grant snapshot")
	}

	async authorize(requests: readonly CommandApprovalRequest[], approve: (missing: readonly number[]) => Promise<boolean>): Promise<boolean> {
		this.assertActive()
		const inputs = [...requests]
		const contexts = inputs.map((request) => {
			this.validateRequest(request)
			this.approvals.delete(request)
			return { identity: identityKey(request.identity), effectiveCommand: request.effectiveCommand, restrictions: [...this.restrictions(request.effectiveCommand)] }
		})
		if (!inputs.length) return true
		if (!await approve(inputs.map((_, index) => index))) return false
		this.assertActive()
		for (const [index, request] of inputs.entries()) {
			const context = contexts[index]
			if (identityKey(request.identity) !== context.identity || request.effectiveCommand !== context.effectiveCommand ||
				this.restrictions(request.effectiveCommand).some((restriction) => !context.restrictions.includes(restriction))) {
				throw new Error("Command restrictions changed during approval")
			}
		}
		for (const [index, request] of inputs.entries()) this.approvals.set(request, contexts[index])
		this.assertCurrent(inputs)
		return true
	}

	assertCurrent(requests: readonly CommandApprovalRequest[]): void {
		this.assertActive()
		for (const request of requests) {
			this.validateRequest(request)
			const approved = this.approvals.get(request)
			if (!approved || identityKey(request.identity) !== approved.identity || request.effectiveCommand !== approved.effectiveCommand ||
				this.restrictions(request.effectiveCommand).some((restriction) => !approved.restrictions.includes(restriction))) {
				throw new Error("Command approval no longer covers the current restrictions")
			}
		}
	}

	private validateRequest(request: CommandApprovalRequest): void {
		if (!request || !isIdentity(request.identity) || typeof request.effectiveCommand !== "string" || !request.effectiveCommand.trim()) {
			throw new Error("Invalid command approval request")
		}
	}
}
