import type { ApiConfiguration, ModelInfo } from "@shared/api"
import type { InferenceSpeed, Mode } from "@shared/storage/types"
import type { DiracStorageMessage } from "@/shared/messages/content"
import type { DiracTool } from "@/shared/tools"
import type {
	ApiConversationCompactionRequest,
	ApiConversationCompactionResult,
	ApiConversationRequestOptions,
} from "./conversation"
import type { ApiStream, ApiStreamUsageChunk } from "./transform/stream"

export type CommonApiHandlerOptions = {
	onRetryAttempt?: ApiConfiguration["onRetryAttempt"]
	disableRetries?: boolean
	enableParallelToolCalling?: boolean
	inferenceSpeed?: InferenceSpeed
}

export interface ApiHandler {
	createMessage(
		systemPrompt: string,
		messages: DiracStorageMessage[],
		tools?: DiracTool[],
		options?: ApiConversationRequestOptions,
	): ApiStream
	compactConversation?(request: ApiConversationCompactionRequest): Promise<ApiConversationCompactionResult>
	supportsNativeWebSearch?(): boolean
	/** Whether Dirac may estimate cost when the provider omits it. Defaults to true. */
	shouldEstimateCost?(): boolean
	getModel(): ApiHandlerModel
	getApiStreamUsage?(): Promise<ApiStreamUsageChunk | undefined>
	abort?(): void
}

export interface ApiHandlerModel {
	id: string
	info: ModelInfo
}

export interface ApiProviderInfo {
	providerId: string
	model: ApiHandlerModel
	mode: Mode
	customPrompt?: string // "compact"
	supportsNativeWebSearch?: boolean
}

export interface SingleCompletionHandler {
	completePrompt(prompt: string): Promise<string>
}
