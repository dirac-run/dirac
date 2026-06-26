import { JSONParser } from "@streamparser/json"
import { DiracAssistantRedactedThinkingBlock, DiracReasoningDetailParam } from "@/shared/messages/content"

export interface ParsedToolUseState {
	id: string
	name: string
	input: Record<string, any>
	signature?: string
	call_id: string
	isComplete: boolean
}

export interface PendingToolUse {
	id: string
	name: string
	input: string
	parsedInput?: unknown
	signature?: string
	jsonParser?: JSONParser
	call_id: string
	isComplete: boolean
}

export interface ToolUseDeltaBlock {
	id?: string
	type?: string
	name?: string
	input?: string
	signature?: string
}

export interface ReasoningDelta {
	id?: string
	reasoning?: string
	signature?: string
	details?: any[]
	redacted_data?: any
}

export interface PendingReasoning {
	id?: string
	content: string
	signature: string
	redactedThinking: DiracAssistantRedactedThinkingBlock[]
	summary: unknown[] | DiracReasoningDetailParam[]
	isComplete: boolean
}
