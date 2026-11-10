import type { ToolInvocationResult } from "../interfaces/ToolInvocationResult"

/** The operation settled, but its post-tool hook did not settle successfully. */
export class ToolInvocationSettlementError extends Error {
	constructor(
		readonly operationResult: ToolInvocationResult,
		cause: unknown,
	) {
		const detail = cause instanceof Error ? cause.message : String(cause)
		super(`Tool operation completed with '${operationResult.outcome}' outcome, but post-tool hook settlement failed: ${detail}`, { cause })
		this.name = "ToolInvocationSettlementError"
	}
}
