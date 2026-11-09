/** Exact execution identity; shell compounds remain indivisible and script wrappers are not identity. */
export type CommandApprovalIdentity =
	| { kind: "command"; command: string; cwd: string }
	| { kind: "script"; script: string; interpreter: string; cwd: string }

export interface CommandApprovalRequest {
	identity: CommandApprovalIdentity
	/** Actual command evaluated by current restrictions, before any cwd-selection wrapper. */
	effectiveCommand: string
}

export interface CommandGrant {
	identity: CommandApprovalIdentity
	/** Applicable restrictive conditions explicitly covered by this approval. */
	restrictions: string[]
}

export interface CommandGrantSnapshot {
	version: 1
	grants: CommandGrant[]
}

/** Child-bound authority; caller cannot choose a root or sibling identity. */
export interface CommandApprovalsCapability {
	/** Serializes lookup, the approval of missing item indices, and durable commit before returning. */
	authorize(requests: readonly CommandApprovalRequest[], approve: (missing: readonly number[]) => Promise<boolean>): Promise<boolean>
	/** Rechecks cancellation and current restrictions immediately before dispatch. */
	assertCurrent(requests: readonly CommandApprovalRequest[]): void
}
