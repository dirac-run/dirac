import type { TranscriptPrefix } from "./TranscriptPrefix"
import type { DiracStorageMessage } from "@/shared/messages/content"
import type { DiracTool } from "@/shared/tools"

export interface ApiConversationCheckpoint {
	providerId: string
	modelId: string
	compactedThroughHistoryIndex: number
	input: unknown[]
}

export interface ApiConversationContinuationReset {
	providerId: string
	modelId: string
	compactedThroughHistoryIndex: number
}

export interface ApiConversationProviderState {
	/** Identifies the checkpoint branch committed in the existing history operation log. */
	historyBranchId?: string
	/** Durable submitted generation; request changes and condensation create linked successors. */
	transcript?: TranscriptPrefix
	previousTranscriptId?: string
	/** Legacy lineage field, read when reopening older state. */
	condensedFromTranscriptId?: string
	submittedHistoryLength?: number
	historyPrefix?: TranscriptPrefix
	transcriptInstructions?: { systemPrompt: string; latestInstructions: string; runtimeContext: string }
	checkpoint?: ApiConversationCheckpoint
	continuationReset?: ApiConversationContinuationReset
	pendingCompaction?: PendingApiConversationCompaction
	deliveredSteeringMessageIds?: string[]
}

export interface PendingApiConversationCompaction {
	conversationHistoryDeletedRange: [number, number]
	previousConversationHistoryDeletedRange?: [number, number]
}

export interface ApiConversationRequestOptions {
	checkpoint?: ApiConversationCheckpoint
	breakProviderContinuation?: boolean
	enableNativeWebSearch?: boolean
}

export interface ApiConversationCompactionRequest {
	systemPrompt: string
	messages: DiracStorageMessage[]
	tools?: DiracTool[]
	checkpoint?: ApiConversationCheckpoint
}

export interface ApiConversationCompactionResult {
	input: unknown[]
}
