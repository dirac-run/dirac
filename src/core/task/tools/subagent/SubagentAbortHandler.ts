import type { SubagentRunResult, SubagentRunStats } from "./SubagentRunner"

// Handles abort/limit-reached result construction for subagent runs.
// Extracted to eliminate duplication of the abort→result pattern (was repeated 4x in run()).
export class SubagentAbortHandler {
	constructor(private getAbortReason: () => string | undefined, private getBestEffortResult: (conversation: any[]) => string) {}

	// Builds the result for an aborted run — completed if limit reached (with partial results), failed otherwise.
	buildAbortResult(conversation: any[], stats: SubagentRunStats, onProgress: (update: any) => void): SubagentRunResult {
		const reason = this.getAbortReason() || "Subagent run cancelled."
		const isLimitReached = /timed out|maximum turns/.test(this.getAbortReason() || "")
		if (isLimitReached) {
			const partialResult = this.getBestEffortResult(conversation)
			const result = `${reason} This is what I have currently:\n\n${partialResult}`
			onProgress({ status: "completed", result, stats: { ...stats } })
			return { status: "completed", result, stats }
		}
		onProgress({ status: "failed", error: reason, stats: { ...stats } })
		return { status: "failed", error: reason, stats }
	}

	// Returns true if the abort reason indicates a limit was reached (timeout or max turns).
	isLimitReached(): boolean {
		return /timed out|maximum turns/.test(this.getAbortReason() || "")
	}
}
