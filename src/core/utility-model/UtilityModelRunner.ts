import { setTimeout as setTimeoutPromise } from "node:timers/promises"
import { ApiConfigurationError } from "@core/api/ApiConfigurationError"
import { getApiRequestRetryDelay, MAX_API_REQUEST_RETRIES } from "@core/api/ApiRequestRetryPolicy"
import { DiracError, DiracErrorType } from "@services/error"
import { buildApiHandlerForSelection, type ApiHandler } from "@core/api"
import type { ApiStream, ApiStreamChunk, ApiStreamUsageChunk } from "@core/api/transform/stream"
import type { ApiConfiguration, ModelProviderSelection } from "@shared/api"
import type { DiracStorageMessage } from "@shared/messages/content"
import type { DiracTool } from "@shared/tools"

export interface UtilityModelRequest {
	systemPrompt: string
	messages: DiracStorageMessage[]
	tools?: DiracTool[]
	signal?: AbortSignal
}

export interface UtilityModelUsageEvent {
	selection: ModelProviderSelection
	usage: ApiStreamUsageChunk
}

export interface UtilityModelResolvedEvent {
	selection: ModelProviderSelection
	modelId: string
}

export interface UtilityModelRetryEvent {
	retryAttempt: number
	maxRetries: number
	delayMs: number
	error: unknown
}

export interface UtilityModelRunnerOptions {
	onUsage?: (event: UtilityModelUsageEvent) => void
	onModelResolved?: (event: UtilityModelResolvedEvent) => void
	onRetry?: (event: UtilityModelRetryEvent) => void | Promise<void>
}

export interface BuildUtilityModelRunnerOptions extends UtilityModelRunnerOptions {
	ulid?: string
}

export type UtilityModelHandlerFactory = () => ApiHandler

/** A recognizable failure for callers that must discard provisional output. */
export class UtilityModelCancelledError extends Error {
	constructor() {
		super("Utility model request cancelled")
		this.name = "UtilityModelCancelledError"
	}
}

/**
 * Runs an independent model request with the task loop's automatic retry policy.
 * Each attempt owns a fresh handler. Output is published only after a complete
 * attempt succeeds, so callers never see a failed attempt's partial tool calls
 * or text. Usage from all attempts is accounted for separately.
 */
export class UtilityModelRunner {
	constructor(
		private readonly selection: ModelProviderSelection,
		private readonly createHandler: UtilityModelHandlerFactory,
		private readonly options: UtilityModelRunnerOptions = {},
	) { }

	run(request: UtilityModelRequest): ApiStream {
		return this.stream(request)
	}

	private async *stream(request: UtilityModelRequest): ApiStream {
		for (let retryAttempt = 0; ; retryAttempt++) {
			this.throwIfCancelled(request.signal)
			// Configuration failures are not provider failures and cannot be repaired by retrying.
			const handler = this.createHandler()
			const modelId = handler.getModel().id
			let chunks: ApiStreamChunk[]
			try {
				chunks = await this.collectAttempt(handler, request)
			} catch (error) {
				this.throwIfCancelled(request.signal)
				if (error instanceof UtilityModelCancelledError || error instanceof ApiConfigurationError) throw error
				const diracError = DiracError.transform(error, modelId, this.selection.provider)
				if (
					retryAttempt === MAX_API_REQUEST_RETRIES ||
					diracError.isErrorType(DiracErrorType.Auth) ||
					diracError.isErrorType(DiracErrorType.Payment)
				) throw error

				const delayMs = getApiRequestRetryDelay(retryAttempt + 1)
				await this.options.onRetry?.({ retryAttempt: retryAttempt + 1, maxRetries: MAX_API_REQUEST_RETRIES, delayMs, error })
				await this.waitForRetry(delayMs, request.signal)
				continue
			}

			this.throwIfCancelled(request.signal)
			this.options.onModelResolved?.({ selection: this.selection, modelId: handler.getModel().id })
			for (const chunk of chunks) {
				this.throwIfCancelled(request.signal)
				yield chunk
			}
			return
		}
	}

	private async collectAttempt(handler: ApiHandler, request: UtilityModelRequest): Promise<ApiStreamChunk[]> {
		let completed = false
		let aborted = false
		const abortHandler = () => {
			if (aborted) return
			aborted = true
			handler.abort?.()
		}
		request.signal?.addEventListener("abort", abortHandler, { once: true })

		try {
			this.throwIfCancelled(request.signal)
			const chunks: ApiStreamChunk[] = []
			for await (const chunk of handler.createMessage(request.systemPrompt, request.messages, request.tools)) {
				this.throwIfCancelled(request.signal)
				if (chunk.type === "usage") this.options.onUsage?.({ selection: this.selection, usage: chunk })
				chunks.push(chunk)
			}
			this.throwIfCancelled(request.signal)
			completed = true
			return chunks
		} finally {
			request.signal?.removeEventListener("abort", abortHandler)
			if (!completed) abortHandler()
		}
	}

	private async waitForRetry(delayMs: number, signal?: AbortSignal): Promise<void> {
		this.throwIfCancelled(signal)
		try {
			await setTimeoutPromise(delayMs, undefined, { signal })
		} catch (error) {
			this.throwIfCancelled(signal)
			throw error
		}
	}

	private throwIfCancelled(signal?: AbortSignal): void {
		if (signal?.aborted) throw new UtilityModelCancelledError()
	}
}

/**
 * Creates a runner whose handler is constructed lazily for each request from a
 * secret-free selection and the caller's existing credential configuration.
 */
export function createUtilityModelRunner(
	baseConfiguration: ApiConfiguration,
	selection: ModelProviderSelection,
	options: BuildUtilityModelRunnerOptions = {},
): UtilityModelRunner {
	return new UtilityModelRunner(
		selection,
		() => buildApiHandlerForSelection(baseConfiguration, selection, { ulid: options.ulid }),
		options,
	)
}
