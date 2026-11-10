import type { DiracUserContent } from "@shared/messages/content"
import type { ToolResponse } from "../types/ToolResponse"

/** Invocation-local state exposed through the environment's mistake-count accessors. */
export interface ToolInvocationEffectsAccumulator {
	consecutiveMistakeCount: number
	/** Explicit operational failure, independent of model mistakes and presentation. */
	failed?: boolean
	context?: DiracUserContent[]
	cancelTask?: boolean
}

/** Effects applied by the task owner only after the invocation has settled. */
export interface ToolInvocationEffects {
	mistake: "reset" | "increment" | "none"
	context?: DiracUserContent[]
	cancelTask?: boolean
	userInput?: {
		message: string
		images?: string[]
		files?: string[]
	}
}

export interface ToolInvocationResult {
	outcome: "success" | "failure" | "cancelled"
	/** An explicit pre-tool hook veto: the operation never started and has no post-hook. */
	preStartVeto?: true
	content: ToolResponse
	effects: ToolInvocationEffects
}
