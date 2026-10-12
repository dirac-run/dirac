import { ModelInfo } from "@shared/api"
import type { InferenceSpeed } from "@shared/storage/types"
import { normalizeInferenceSpeed, normalizeOpenaiReasoningEffort } from "@shared/storage/types"
import { calculateApiCostOpenAI, getModelInfoForInferenceSpeed } from "@utils/cost"
import OpenAI from "openai"
import { ChatCompletionReasoningEffort, ChatCompletionTool } from "openai/resources/chat/completions"
import { MessageEvent as UndiciMessageEvent, WebSocket as UndiciWebSocket } from "undici"
import { buildExternalBasicHeaders } from "@/services/EnvUtils"
import { getErrorMessage } from "@/shared/errors"

import type { ApiStreamChunk } from "../transform/stream"
import type { WebSearchChatTool } from "../transform/tool-call-processor"

/** Loose usage shape: Codex responses add cache_creation_tokens beyond the SDK's ResponseUsage. */
interface ResponsesUsageDetails {
	input_tokens?: number
	output_tokens?: number
	input_tokens_details?: { cached_tokens?: number; cache_creation_tokens?: number } | null
	output_tokens_details?: { reasoning_tokens?: number } | null
}

/** Codex streams emit richer error payloads than the SDK's ResponseErrorEvent declares. */
interface CodexStreamErrorEvent {
	type: "error"
	code?: string | null
	message?: string
	param?: string | null
	status?: number | string
	status_code?: number | string
	error?: {
		message?: string
		code?: string
		status?: number | string
		status_code?: number | string
		param?: string
		details?: { param?: string }
	} | null
}

/** Codex adds status_code and error.param to the failed Response object. */
interface CodexResponseExtensions {
	status_code?: number
	error?: {
		message?: string
		code?: string
		param?: string
		status?: number | string
		status_code?: number | string
	} | null
}

interface CodexRateLimitsEvent {
	type: "codex.rate_limits"
	[key: string]: unknown
}

/** Stream event union: SDK events plus the Codex extension events this client parses. */
export type ResponsesStreamEvent = OpenAI.Responses.ResponseStreamEvent | CodexStreamErrorEvent | CodexRateLimitsEvent

export type OpenAIServiceTier = "default" | "fast" | "priority"

export function getOpenAIServiceTier(
	speed?: InferenceSpeed,
	fastTier: "fast" | "priority" = "fast",
): OpenAIServiceTier | undefined {
	switch (normalizeInferenceSpeed(speed)) {
		case "fast":
			return fastTier
		case "standard":
			return "default"
		case "default":
			return undefined
	}
}

export function normalizeOpenAIServiceTier(serviceTier: unknown): InferenceSpeed | undefined {
	if (serviceTier === "fast" || serviceTier === "priority") return "fast"
	if (serviceTier === "default") return "standard"
	return undefined
}

function isWebSearchTool(tool: ChatCompletionTool | WebSearchChatTool): tool is WebSearchChatTool {
	return tool.type === "web_search"
}

export interface ResponsesWebsocketOptions {
	apiKey: string
	baseUrl?: string
	websocketUrl?: string
	extraHeaders?: Record<string, string>
}

export async function* yieldUsage(
	info: ModelInfo,
	usage: ResponsesUsageDetails | undefined,
	id?: string,
	serviceTier?: unknown,
): AsyncGenerator<ApiStreamChunk> {
	if (!usage) return
	const inputTokens = usage.input_tokens || 0
	const outputTokens = usage.output_tokens || 0
	const cacheReadTokens = usage.input_tokens_details?.cached_tokens || 0
	const cacheWriteTokens = usage.input_tokens_details?.cache_creation_tokens || 0
	const reasoningTokens = usage.output_tokens_details?.reasoning_tokens || 0
	const inferenceSpeed = normalizeOpenAIServiceTier(serviceTier)

	const totalCost = calculateApiCostOpenAI(
		getModelInfoForInferenceSpeed(info, inferenceSpeed),
		inputTokens,
		outputTokens,
		cacheWriteTokens,
		cacheReadTokens,
	)

	const nonCachedInputTokens = Math.max(0, inputTokens - cacheReadTokens - cacheWriteTokens)

	yield {
		type: "usage",
		inputTokens: nonCachedInputTokens,
		outputTokens,
		cacheWriteTokens,
		cacheReadTokens,
		reasoningTokens,
		totalCost,
		...(inferenceSpeed ? { inferenceSpeed } : {}),
		...(id ? { id } : {}),
	}
}

export function mapResponseTools(tools: (ChatCompletionTool | WebSearchChatTool)[], strict = false): OpenAI.Responses.Tool[] {
	const mapped = tools.map((tool): OpenAI.Responses.Tool | undefined => {
		if (tool.type === "function") {
			return {
				type: "function" as const,
				name: tool.function.name,
				description: tool.function.description,
				parameters: tool.function.parameters ?? null,
				strict: strict || (tool.function.strict ?? false),
			}
		}
		if (isWebSearchTool(tool)) {
			return {
				type: "web_search",
				...(tool.search_context_size
					? { search_context_size: tool.search_context_size as "low" | "medium" | "high" }
					: {}),
				...(tool.filters ? { filters: tool.filters } : {}),
				...(tool.user_location ? { user_location: tool.user_location } : {}),
				...(tool.external_web_access !== undefined ? { external_web_access: tool.external_web_access } : {}),
			} as OpenAI.Responses.WebSearchTool
		}
		return undefined
	})

	return mapped.filter((tool): tool is OpenAI.Responses.Tool => tool !== undefined)
}

export function buildResponseCreateParams(args: {
	modelId: string
	systemPrompt: string
	input: OpenAI.Responses.ResponseInput
	tools: OpenAI.Responses.Tool[]
	reasoningEffort?: string
	previousResponseId?: string
	store?: boolean
	enableParallelToolCalling?: boolean
	reasoningContext?: "all_turns"
	serviceTier?: OpenAIServiceTier
}): OpenAI.Responses.ResponseCreateParamsStreaming {
	const requestedEffort = normalizeOpenaiReasoningEffort(args.reasoningEffort)
	const reasoning: { effort?: ChatCompletionReasoningEffort; summary: "auto"; context?: "all_turns" } | undefined =
		requestedEffort === "none" && !args.reasoningContext
			? undefined
			: {
					summary: "auto",
					...(requestedEffort !== "none" ? { effort: requestedEffort as ChatCompletionReasoningEffort } : {}),
					...(args.reasoningContext ? { context: args.reasoningContext } : {}),
				}

	return {
		model: args.modelId,
		instructions: args.systemPrompt,
		input: args.input,
		stream: true,
		tools: args.tools,
		...(args.serviceTier ? { service_tier: args.serviceTier } : {}),
		...(args.tools.length > 0 && args.enableParallelToolCalling !== undefined
			? { parallel_tool_calls: args.enableParallelToolCalling }
			: {}),
		...(args.store !== undefined ? { store: args.store } : { store: !args.previousResponseId }),
		...(args.previousResponseId ? { previous_response_id: args.previousResponseId } : {}),
		...(reasoning ? { reasoning } : {}),
	} as OpenAI.Responses.ResponseCreateParamsStreaming
}

export async function* parseSseResponse(body: ReadableStream<Uint8Array>): AsyncIterable<ResponsesStreamEvent> {
	const reader = body.getReader()
	const decoder = new TextDecoder()
	let buffer = ""

	try {
		while (true) {
			const { done, value } = await reader.read()
			if (done) {
				break
			}

			buffer += decoder.decode(value, { stream: true })
			const lines = buffer.split("\n")
			buffer = lines.pop() || ""

			for (const line of lines) {
				if (line.startsWith("data: ")) {
					const data = line.slice(6).trim()
					if (data === "[DONE]") {
						return
					}

					yield JSON.parse(data)
				}
			}
		}
	} finally {
		try {
			await reader.cancel()
		} finally {
			reader.releaseLock()
		}
	}
}
export interface ProcessResponsesEventsOptions {
	onRateLimits?: (event: unknown) => void
	onResponseCompleted?: (response: { id?: string }) => void
}

interface FunctionCallStreamState {
	call_id?: string
	name?: string
	id?: string
	didEmitArgumentContent?: boolean
}

export async function* processResponsesEvents(
	stream: AsyncIterable<ResponsesStreamEvent>,
	modelInfo: ModelInfo,
	options: ProcessResponsesEventsOptions = {},
): AsyncGenerator<ApiStreamChunk> {
	const functionCallByItemId = new Map<string, FunctionCallStreamState>()

	for await (const chunk of stream) {
		if (chunk.type === "codex.rate_limits") {
			options.onRateLimits?.(chunk)
			continue
		}
		yield* processResponseEvent(chunk, functionCallByItemId, modelInfo, options)
	}
}
// Dispatches a single Responses API stream event to the appropriate handler.
async function* processResponseEvent(
	chunk: Exclude<ResponsesStreamEvent, CodexRateLimitsEvent>,
	functionCallByItemId: Map<string, FunctionCallStreamState>,
	modelInfo: ModelInfo,
	options: ProcessResponsesEventsOptions,
): AsyncGenerator<ApiStreamChunk> {
	switch (chunk.type) {
		case "response.output_item.added":
			yield* handleOutputItemAdded(chunk.item, functionCallByItemId)
			break
		case "response.output_item.done":
			yield* handleOutputItemDone(chunk.item, functionCallByItemId)
			break
		case "response.reasoning_summary_part.added": {
			const stepSeparator = chunk.summary_index > 0 ? "\n\n" : ""
			yield { type: "reasoning", id: chunk.item_id, reasoning: `${stepSeparator}${chunk.part.text}` }
			break
		}
		case "response.reasoning_summary_text.delta":
			yield { type: "reasoning", id: chunk.item_id, reasoning: chunk.delta }
			break
		case "response.reasoning_summary_part.done":
			yield { type: "reasoning", id: chunk.item_id, details: chunk.part, reasoning: "" }
			break
		case "response.output_text.delta":
			if (chunk.delta) yield { id: chunk.item_id, type: "text", text: chunk.delta }
			break
		case "response.reasoning_text.delta":
			if (chunk.delta) yield { id: chunk.item_id, type: "reasoning", reasoning: chunk.delta }
			break
		case "response.function_call_arguments.delta":
			yield* handleFunctionCallArgumentsDelta(chunk, functionCallByItemId)
			break
		case "response.function_call_arguments.done":
			yield* handleFunctionCallArgumentsDone(chunk, functionCallByItemId)
			break
		case "response.failed": {
			// Codex adds status_code and error.param beyond the SDK's Response shape
			const response = chunk.response as OpenAI.Responses.Response & CodexResponseExtensions
			const error: Error & { code?: string; status?: number; details?: { param?: string } } = new Error(
				`Codex API response failed: ${response?.error?.message || response?.status || "Response failed"}`,
			)
			error.code = response?.error?.code
			if (typeof response?.status_code === "number") error.status = response.status_code
			if (typeof response?.error?.param === "string") error.details = { param: response.error.param }
			throw error
		}
		case "response.completed":
			options.onResponseCompleted?.(chunk.response)
			if (chunk.response?.usage) {
				yield* yieldUsage(modelInfo, chunk.response.usage, chunk.response.id, chunk.response.service_tier)
			}
			break
		case "error": {
			// Codex stream errors carry fields the SDK's ResponseErrorEvent doesn't declare
			const evt = chunk as CodexStreamErrorEvent
			const errMsg = evt.message || evt.error?.message || "Unknown API error"
			const error: Error & {
				code?: string
				status?: number | string
				details?: { param?: string }
			} = new Error(`Codex API stream error: ${errMsg}`)
			const code = evt.code ?? evt.error?.code
			const status = evt.status ?? evt.status_code ?? evt.error?.status ?? evt.error?.status_code
			const param = evt.param ?? evt.error?.param ?? evt.error?.details?.param
			if (typeof code === "string") error.code = code
			if (typeof status === "number" || typeof status === "string") error.status = status
			if (typeof param === "string") error.details = { param }
			throw error
		}
	}
}

// Handles response.output_item.added: function_call, reasoning (redacted), web_search_call.
function* handleOutputItemAdded(
	item: OpenAI.Responses.ResponseOutputItem,
	functionCallByItemId: Map<string, FunctionCallStreamState>,
): Generator<ApiStreamChunk> {
	if (item.type === "function_call" && item.id) {
		functionCallByItemId.set(item.id, {
			call_id: item.call_id,
			name: item.name,
			id: item.id,
			didEmitArgumentContent: Boolean(item.arguments),
		})
		yield {
			id: item.id,
			type: "tool_calls",
			tool_call: { call_id: item.call_id, function: { id: item.id, name: item.name, arguments: item.arguments } },
		}
	}
	if (item.type === "reasoning" && item.encrypted_content && item.id) {
		yield { type: "reasoning", id: item.id, reasoning: "", redacted_data: item.encrypted_content ?? undefined }
	}
	if (item.type === "web_search_call" && item.id) {
		const query = item.action?.type === "search" ? item.action.query : undefined
		yield { id: item.id, type: "text", text: `\n[Web Search: ${query || "Searching..."}]\n` }
	}
}

// Handles response.output_item.done: function_call (final), reasoning (summary).
function* handleOutputItemDone(
	item: OpenAI.Responses.ResponseOutputItem,
	functionCallByItemId: Map<string, FunctionCallStreamState>,
): Generator<ApiStreamChunk> {
	if (item.type === "function_call") {
		const pendingCall = item.id ? functionCallByItemId.get(item.id) : undefined
		if (!pendingCall || (!pendingCall.didEmitArgumentContent && item.arguments)) {
			yield {
				type: "tool_calls",
				id: item.id || item.call_id,
				tool_call: { call_id: item.call_id, function: { id: item.id, name: item.name, arguments: item.arguments } },
			}
			if (pendingCall) pendingCall.didEmitArgumentContent = true
		}
	}
	if (item.type === "reasoning") {
		yield { type: "reasoning", id: item.id, details: item.summary, reasoning: "" }
	}
}

// Handles streaming function call argument deltas.
function* handleFunctionCallArgumentsDelta(
	chunk: OpenAI.Responses.ResponseFunctionCallArgumentsDeltaEvent,
	functionCallByItemId: Map<string, FunctionCallStreamState>,
): Generator<ApiStreamChunk> {
	const pendingCall = functionCallByItemId.get(chunk.item_id)
	if (pendingCall && chunk.delta) pendingCall.didEmitArgumentContent = true
	const functionId = pendingCall?.id || chunk.item_id
	yield {
		id: functionId,
		type: "tool_calls",
		tool_call: {
			call_id: pendingCall?.call_id,
			function: { id: functionId, name: pendingCall?.name, arguments: chunk.delta },
		},
	}
}

// Handles completed function call arguments.
function* handleFunctionCallArgumentsDone(
	chunk: OpenAI.Responses.ResponseFunctionCallArgumentsDoneEvent,
	functionCallByItemId: Map<string, FunctionCallStreamState>,
): Generator<ApiStreamChunk> {
	if (!chunk.item_id || !chunk.name || !chunk.arguments) return
	const pendingCall = functionCallByItemId.get(chunk.item_id)
	if (pendingCall?.didEmitArgumentContent) return
	if (pendingCall) pendingCall.didEmitArgumentContent = true
	const functionId = pendingCall?.id || chunk.item_id
	yield {
		id: functionId,
		type: "tool_calls",
		tool_call: { call_id: pendingCall?.call_id, function: { id: functionId, name: chunk.name, arguments: chunk.arguments } },
	}
}

export class ResponsesWebsocketManager {
	private ws: UndiciWebSocket | undefined
	private readyPromise: Promise<UndiciWebSocket> | undefined
	private requestInFlight = false

	constructor(private options: ResponsesWebsocketOptions) {}

	async ensureWebsocket(): Promise<UndiciWebSocket> {
		if (this.ws && this.ws.readyState === UndiciWebSocket.OPEN) {
			return this.ws
		}

		if (this.readyPromise) {
			return this.readyPromise
		}

		this.close()

		const url = this.options.websocketUrl || "wss://api.openai.com/v1/responses"
		const ws = new UndiciWebSocket(url, {
			headers: {
				Authorization: `Bearer ${this.options.apiKey}`,
				"OpenAI-Beta": "responses_websockets=2026-02-06",
				...buildExternalBasicHeaders(),
				...this.options.extraHeaders,
			},
		})

		this.ws = ws
		const readyPromise = new Promise<UndiciWebSocket>((resolve, reject) => {
			const cleanup = () => {
				ws.removeEventListener("open", handleOpen)
				ws.removeEventListener("error", handleError)
				ws.removeEventListener("close", handleClose)
			}
			const handleOpen = () => {
				cleanup()
				resolve(ws)
			}
			const handleError = () => {
				cleanup()
				reject(new Error("Failed to open Responses websocket"))
			}
			const handleClose = () => {
				cleanup()
				reject(new Error("Responses websocket closed before opening"))
			}
			ws.addEventListener("open", handleOpen)
			ws.addEventListener("error", handleError)
			ws.addEventListener("close", handleClose)
		})

		this.readyPromise = readyPromise

		try {
			return await readyPromise
		} catch (error) {
			if (this.ws === ws) {
				this.ws = undefined
			}
			throw error
		} finally {
			if (this.readyPromise === readyPromise) {
				this.readyPromise = undefined
			}
		}
	}

	close() {
		this.readyPromise = undefined
		if (this.ws) {
			try {
				this.ws.close()
			} catch {
				/* ws may already be closed/dead — safe to ignore */
			}
			this.ws = undefined
		}
	}

	async *createResponseEvents(
		params: OpenAI.Responses.ResponseCreateParamsStreaming,
	): AsyncGenerator<OpenAI.Responses.ResponseStreamEvent> {
		if (this.requestInFlight) {
			const error: Error & { code?: string } = new Error("Websocket response.create is already in progress")
			error.code = "websocket_concurrency_limit"
			throw error
		}

		const ws = await this.ensureWebsocket()
		this.requestInFlight = true

		const eventQueue: OpenAI.Responses.ResponseStreamEvent[] = []
		let resolver: (() => void) | undefined
		let completed = false
		let failure: (Error & { code?: string }) | undefined

		const wake = () => {
			const next = resolver
			resolver = undefined
			next?.()
		}

		const handleMessage = (evt: UndiciMessageEvent) => {
			try {
				let raw = ""
				if (typeof evt.data === "string") {
					raw = evt.data
				} else if (evt.data instanceof ArrayBuffer) {
					raw = new TextDecoder().decode(new Uint8Array(evt.data))
				} else if (ArrayBuffer.isView(evt.data)) {
					raw = new TextDecoder().decode(new Uint8Array(evt.data.buffer, evt.data.byteOffset, evt.data.byteLength))
				} else {
					raw = String(evt.data)
				}
				const parsed = JSON.parse(raw)

				if (parsed?.type === "error" && parsed?.error) {
					const error: Error & { code?: string; status?: number; details?: { param?: string } } = new Error(
						parsed.error.message || "Responses websocket error",
					)
					error.code = parsed.error.code
					if (typeof parsed.error.status === "number") error.status = parsed.error.status
					if (typeof parsed.error.param === "string") error.details = { param: parsed.error.param }
					if (typeof parsed.error.details?.param === "string") error.details = { param: parsed.error.details.param }
					failure = error
					completed = true
					wake()
					return
				}

				eventQueue.push(parsed as OpenAI.Responses.ResponseStreamEvent)
				if (parsed?.type === "response.completed" || parsed?.type === "response.failed") {
					completed = true
				}
				wake()
			} catch (error) {
				const parseError: Error & { code?: string } = new Error(
					`Failed to parse websocket event: ${getErrorMessage(error)}`,
				)
				parseError.code = "websocket_parse_error"
				failure = parseError
				completed = true
				wake()
			}
		}

		const handleError = () => {
			const error: Error & { code?: string } = new Error("Responses websocket emitted an error event")
			error.code = "websocket_error"
			failure = error
			completed = true
			wake()
		}

		const handleClose = () => {
			if (!completed) {
				const error: Error & { code?: string } = new Error("Responses websocket closed during response stream")
				error.code = "websocket_closed"
				failure = error
				completed = true
				wake()
			}
		}

		ws.addEventListener("message", handleMessage)
		ws.addEventListener("error", handleError)
		ws.addEventListener("close", handleClose)

		try {
			ws.send(
				JSON.stringify({
					type: "response.create",
					...params,
				}),
			)

			while (!completed || eventQueue.length > 0) {
				if (eventQueue.length === 0) {
					await new Promise<void>((resolve) => {
						resolver = resolve
					})
					continue
				}

				const event = eventQueue.shift()
				if (event) {
					yield event
				}
			}

			if (failure) {
				throw failure
			}
		} finally {
			ws.removeEventListener("message", handleMessage)
			ws.removeEventListener("error", handleError)
			ws.removeEventListener("close", handleClose)
			this.requestInFlight = false
		}
	}
}

export function shouldRetryWithFullContext(error: unknown, hadPreviousResponseId: boolean): boolean {
	if (!hadPreviousResponseId) {
		return false
	}

	const errorCode =
		typeof error === "object" && error && "code" in error && typeof (error as { code: unknown }).code === "string"
			? (error as { code: string }).code
			: undefined

	const status =
		typeof error === "object" && error && "status" in error && typeof (error as { status: unknown }).status === "number"
			? (error as { status: number }).status
			: undefined

	const message = getErrorMessage(error)

	if (errorCode === "previous_response_not_found" || message.includes("previous_response_not_found")) {
		return true
	}

	// Codex seems to return 404 for missing previous_response_id
	if (status === 404 || message.includes("404")) {
		// Only retry if the 404 is NOT about an item in the input
		const details =
			typeof error === "object" && error && "details" in error
				? (error as { details?: { param?: string } }).details
				: undefined
		if (details?.param === "input") {
			return false
		}
		return true
	}

	return false
}
