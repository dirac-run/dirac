import type { ChildProcess } from "node:child_process"
import { NativeSandboxError } from "./types"

export interface ProcessLifetimeOptions {
	/** Namespace/container lifetime owns descendants, unlike a POSIX process group. */
	descendantsContained: boolean
	killGroup(): void
	cleanup(): void
	drainTimeoutMs?: number
}

/** Exit is not pipe drain: a descendant can retain stdout after the leader dies. */
export function ownNativeProcess(child: ChildProcess, options: ProcessLifetimeOptions): { terminate(): Promise<void> } {
	let closed = false
	let exited = false
	let groupKilled = false
	let cleanupError: Error | undefined
	let drainTimer: NodeJS.Timeout | undefined
	let resolveClose: () => void
	const completion = new Promise<void>((resolve) => { resolveClose = resolve })
	const kill = () => {
		if (groupKilled || !child.pid) return
		options.killGroup()
		groupKilled = true
	}
	const report = (error: Error) => {
		cleanupError = error
		child.emit("error", error)
	}
	child.once("exit", () => {
		exited = true
		// Seatbelt inherits restrictions across fork/exec, but has no container lifetime.
		// Kill the original group now, NOT on close (which its descendants can prevent).
		if (!options.descendantsContained) {
			try { kill() } catch (error) { report(error as Error) }
		}
		// Even a namespace helper can fail before containment is established and leave
		// descendants holding output or policy-delivery descriptors. Never wait forever
		// or turn forced stream disposal into a successful cleanup claim.
		drainTimer = setTimeout(() => {
			if (closed) return
			for (const stream of child.stdio) stream?.destroy()
			report(new NativeSandboxError(
				options.descendantsContained
					? "Native leader exited but pipes remain open; descendant cleanup is uncertain. Pipe drain was stopped."
					: "Native leader exited but output pipes remain open; escaped descendants may remain. Output drain was stopped.",
				"cleanup-failed", "execution-uncertain",
			))
		}, options.drainTimeoutMs ?? 1000)
		drainTimer.unref()
	})
	child.once("close", () => {
		closed = true
		clearTimeout(drainTimer)
		try { options.cleanup() } catch (error) { report(error as Error) }
		resolveClose()
	})
	return {
		async terminate(): Promise<void> {
			if (!closed && !exited) kill()
			let timer: NodeJS.Timeout | undefined
			try {
				await Promise.race([
					completion,
					new Promise<never>((_, reject) => {
						timer = setTimeout(() => reject(new NativeSandboxError(
							"Native execution did not drain after cancellation; descendants may remain.",
							"cleanup-failed", "execution-uncertain",
						)), 5000)
					}),
				])
			} finally { clearTimeout(timer) }
			if (cleanupError) throw cleanupError
			if (!options.descendantsContained && child.pid) {
				throw new NativeSandboxError(
					"The original process group was stopped, but Seatbelt cannot establish cleanup of escaped-session descendants.",
					"cleanup-failed", "execution-uncertain",
				)
			}
		},
	}
}
