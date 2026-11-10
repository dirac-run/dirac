import type { ToolExecutionIdentity, ToolExecutionWaitState } from "@shared/toolExecution"

interface ToolExecutionCapabilities {
	readonly identity: ToolExecutionIdentity
	readonly signal: AbortSignal
	appendOutput(text: string): Promise<void>
}

/** Raw owner context, wrapped once when a prepared invocation starts. */
export interface ToolExecutionScopeContext extends ToolExecutionCapabilities {
	waiting(state: ToolExecutionWaitState): Promise<void>
	resume(): Promise<void>
}

/** A single outstanding interaction; release is idempotent, including after cancellation. */
export interface ToolExecutionWaitLease {
	release(): Promise<void>
}

/** Invocation-local capabilities supplied by the execution owner, not task-global state. */
export interface ToolExecutionScope extends ToolExecutionCapabilities {
	beginWait(state: ToolExecutionWaitState): Promise<ToolExecutionWaitLease>
}
