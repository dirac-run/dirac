import type { ToolExecutionWaitState } from "@shared/toolExecution"
import type {
	ToolExecutionScope,
	ToolExecutionScopeContext,
	ToolExecutionWaitLease,
} from "../interfaces/ToolExecutionScope"

/** Serializes owner transitions while independently leased card waits overlap. */
export function createToolExecutionScope(context: ToolExecutionScopeContext): ToolExecutionScope {
	const waits = new Map<symbol, ToolExecutionWaitState>()
	let serial: Promise<unknown> = Promise.resolve()
	const exclusive = <T>(operation: () => Promise<T>): Promise<T> => {
		const result = serial.then(operation)
		serial = result.then(() => undefined, () => undefined)
		return result
	}
	return {
		identity: context.identity,
		signal: context.signal,
		appendOutput: (text) => context.appendOutput(text),
		beginWait: (state) => exclusive(async (): Promise<ToolExecutionWaitLease> => {
			context.signal.throwIfAborted()
			if (waits.size === 0) await context.waiting(state)
			const token = Symbol("execution wait")
			waits.set(token, structuredClone(state))
			return {
				release: () => exclusive(async () => {
					if (!waits.has(token)) return
					if (!context.signal.aborted) {
						if (waits.size === 1) await context.resume()
						else if (waits.keys().next().value === token) {
							const next = [...waits.entries()].find(([candidate]) => candidate !== token)!
							await context.waiting(next[1])
						}
					}
					waits.delete(token)
				}),
			}
		}),
	}
}
