import pTimeout from "p-timeout"

export const DEFAULT_BOUNDED_TOOL_EXECUTION_MS = 30_000

export class ToolTimeoutError extends Error {
	readonly outcome = "timeout"

	constructor(
		readonly toolName: string,
		readonly operation: string,
		readonly timeoutMs: number,
	) {
		super(`Tool '${toolName}' timed out after ${timeoutMs / 1_000} seconds while ${operation}.`)
		this.name = "ToolTimeoutError"
	}
}

interface ToolExecutionDeadlineOptions {
	timeoutMs?: number
	cancellationSignal?: AbortSignal
	clock?: () => number
}

/** Applies one shared wall-clock budget across a tool's awaited execution operations. */
export class ToolExecutionDeadline {
	private expiresAt: number | undefined
	private readonly timeoutMs: number
	private readonly cancellationSignal?: AbortSignal
	private readonly clock: () => number

	constructor(
		private readonly toolName: string,
		options: ToolExecutionDeadlineOptions = {},
	) {
		this.timeoutMs = options.timeoutMs ?? DEFAULT_BOUNDED_TOOL_EXECUTION_MS
		this.cancellationSignal = options.cancellationSignal
		this.clock = options.clock ?? Date.now
	}

	/** Abort owned work on expiry/cancellation, then join its resource cleanup before returning. */
	run<T>(operationName: string, operation: (signal: AbortSignal) => Promise<T>): Promise<T> {
		return this.awaitOperation(operationName, operation, "join")
	}

	/**
	 * Bound observation of a service-owned read query, not the lifetime of its underlying work.
	 * The service may continue after timeout/cancellation; this does not report its resources settled.
	 * Queries must not own execution resources (processes, streams, writes), and late results must
	 * not commit tool context, cards, or effects. Keep such commits after awaiting this method.
	 */
	observe<T>(operationName: string, query: (signal: AbortSignal) => Promise<T>): Promise<T> {
		return this.awaitOperation(operationName, query, "service-owned")
	}

	private async awaitOperation<T>(
		operationName: string,
		operation: (signal: AbortSignal) => Promise<T>,
		cleanup: "join" | "service-owned",
	): Promise<T> {
		const timeoutError = new ToolTimeoutError(this.toolName, operationName, this.timeoutMs)
		this.expiresAt ??= this.clock() + this.timeoutMs
		const remainingMs = this.expiresAt - this.clock()
		if (remainingMs <= 0) throw timeoutError

		const abortController = new AbortController()
		const cancelOperation = () => abortController.abort(this.cancellationSignal?.reason)
		if (this.cancellationSignal?.aborted) {
			cancelOperation()
			throw this.cancellationSignal.reason instanceof Error
				? this.cancellationSignal.reason
				: new Error("Tool execution cancelled")
		}
		this.cancellationSignal?.addEventListener("abort", cancelOperation, { once: true })
		try {
			const execution = operation(abortController.signal)
			try {
				return await pTimeout(execution, {
					milliseconds: remainingMs,
					message: timeoutError,
					signal: this.cancellationSignal,
				})
			} catch (error) {
				if (error !== timeoutError && !this.cancellationSignal?.aborted) throw error
				if (error === timeoutError) abortController.abort(timeoutError)
				// pTimeout observes late rejection even when the service outlives this observer.
				if (cleanup === "service-owned") throw error

				// Cancellation requests a stop; only actual settlement releases cleanup ownership.
				try {
					await execution
				} catch (cleanupError) {
					if (cleanupError !== error) {
						if (!(error instanceof Error)) {
							throw new AggregateError([error, cleanupError], "Tool cancellation and cleanup failed")
						}
						error.cause = cleanupError
					}
				}
				throw error
			}
		} finally {
			this.cancellationSignal?.removeEventListener("abort", cancelOperation)
		}
	}
}
