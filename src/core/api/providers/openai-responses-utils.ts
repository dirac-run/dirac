import { ModelInfo } from "@shared/api"
import { normalizeOpenaiReasoningEffort } from "@shared/storage/types"
import { calculateApiCostOpenAI } from "@utils/cost"
import OpenAI from "openai"
import { ChatCompletionReasoningEffort, ChatCompletionTool } from "openai/resources/chat/completions"
import { MessageEvent as UndiciMessageEvent, WebSocket as UndiciWebSocket } from "undici"
import { buildExternalBasicHeaders } from "@/services/EnvUtils"

// ChatCompletionTool doesn't include web_search; define the shape we use
interface WebSearchChatTool {
	type: "web_search"
	search_context_size?: string
	filters?: object
	user_location?: object
	external_web_access?: boolean
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

export async function* yieldUsage(info: ModelInfo, usage: any, id?: string): AsyncGenerator<any> {
	if (!usage) return
	const inputTokens = usage.input_tokens || 0
	const outputTokens = usage.output_tokens || 0
	const cacheReadTokens = usage.input_tokens_details?.cached_tokens || 0
	const cacheWriteTokens = usage.input_tokens_details?.cache_creation_tokens || 0
	const reasoningTokens = usage.output_tokens_details?.reasoning_tokens || 0
	const totalTokens = usage.total_tokens || 0

	const totalCost = calculateApiCostOpenAI(info, inputTokens, outputTokens + reasoningTokens, cacheWriteTokens, cacheReadTokens)

	const nonCachedInputTokens = Math.max(0, inputTokens - cacheReadTokens - cacheWriteTokens)

	yield {
		type: "usage",
		inputTokens: nonCachedInputTokens,
		outputTokens: outputTokens,
		cacheWriteTokens: cacheWriteTokens,
		cacheReadTokens: cacheReadTokens,
		reasoningTokens: reasoningTokens,
		totalCost: totalCost,
		...(id ? { id } : {}),
	}
}

export function mapResponseTools(tools: ChatCompletionTool[], strict = false): OpenAI.Responses.Tool[] {
	const mapped = (tools as (ChatCompletionTool | WebSearchChatTool)[]).map((tool): OpenAI.Responses.Tool | undefined => {
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
}): OpenAI.Responses.ResponseCreateParamsStreaming {
	const requestedEffort = normalizeOpenaiReasoningEffort(args.reasoningEffort)
	const reasoning: { effort: ChatCompletionReasoningEffort; summary: "auto" } | undefined =
		requestedEffort === "none"
			? undefined
			: {
				effort: requestedEffort as ChatCompletionReasoningEffort,
				summary: "auto",
			}

	return {
		model: args.modelId,
		instructions: args.systemPrompt,
		input: args.input,
		stream: true,
		tools: args.tools,
		...(args.store !== undefined ? { store: args.store } : { store: !args.previousResponseId }),
		...(args.previousResponseId ? { previous_response_id: args.previousResponseId } : {}),
		...(reasoning ? { reasoning } : {}),
	}
}

export async function* parseSseResponse(body: ReadableStream<Uint8Array>): AsyncIterable<any> {
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
						continue
					}

					try {
						yield JSON.parse(data)
					} catch (e) {
						// Ignore parse errors for partial lines
					}
				}
			}
		}
	} finally {
		reader.releaseLock()
	}
}
export async function* processResponsesEvents(
	stream: AsyncIterable<OpenAI.Responses.ResponseStreamEvent>,
	modelInfo: ModelInfo,
): AsyncGenerator<any> {
	const functionCallByItemId = new Map<string, { call_id?: string; name?: string; id?: string }>()

	for await (const chunk of stream) {
		yield* processResponseEvent(chunk, functionCallByItemId, modelInfo)
	}
}

// Dispatches a single Responses API stream event to the appropriate handler.
async function* processResponseEvent(
	chunk: any,
	functionCallByItemId: Map<string, { call_id?: string; name?: string; id?: string }>,
	modelInfo: ModelInfo,
): AsyncGenerator<any> {
	switch (chunk.type) {
		case "response.output_item.added":
			yield* handleOutputItemAdded(chunk.item, functionCallByItemId)
			break
		case "response.output_item.done":
			yield* handleOutputItemDone(chunk.item, functionCallByItemId)
			break
		case "response.reasoning_summary_part.added":
			yield { type: "reasoning", id: chunk.item_id, reasoning: chunk.part.text }
			break
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
		case "response.completed":
			if (chunk.response?.usage) yield* yieldUsage(modelInfo, chunk.response.usage, chunk.response.id)
			break
	}
}

// Handles response.output_item.added: function_call, reasoning (redacted), web_search_call.
function* handleOutputItemAdded(
	item: any,
	functionCallByItemId: Map<string, { call_id?: string; name?: string; id?: string }>,
): Generator<any> {
	if (item.type === "function_call" && item.id) {
		functionCallByItemId.set(item.id, { call_id: item.call_id, name: item.name, id: item.id })
		yield {
			id: item.id,
			type: "tool_calls",
			tool_call: { call_id: item.call_id, function: { id: item.id, name: item.name, arguments: item.arguments } },
		}
	}
	if (item.type === "reasoning" && item.encrypted_content && item.id) {
		yield { type: "reasoning", id: item.id, reasoning: "", redacted_data: item.encrypted_content }
	}
	if (item.type === "web_search_call" && item.id) {
		yield { id: item.id, type: "text", text: `\n[Web Search: ${item.action?.query || "Searching..."}]\n` }
	}
}

// Handles response.output_item.done: function_call (final), reasoning (summary).
function* handleOutputItemDone(
	item: any,
	functionCallByItemId: Map<string, { call_id?: string; name?: string; id?: string }>,
): Generator<any> {
	if (item.type === "function_call") {
		if (item.id) functionCallByItemId.set(item.id, { call_id: item.call_id, name: item.name, id: item.id })
		yield {
			type: "tool_calls",
			id: item.id || item.call_id,
			tool_call: { call_id: item.call_id, function: { id: item.id, name: item.name, arguments: item.arguments } },
		}
	}
	if (item.type === "reasoning") {
		yield { type: "reasoning", id: item.id, details: item.summary, reasoning: "" }
	}
}

// Handles streaming function call argument deltas.
function* handleFunctionCallArgumentsDelta(
	chunk: any,
	functionCallByItemId: Map<string, { call_id?: string; name?: string; id?: string }>,
): Generator<any> {
	const pendingCall = functionCallByItemId.get(chunk.item_id)
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
	chunk: any,
	functionCallByItemId: Map<string, { call_id?: string; name?: string; id?: string }>,
): Generator<any> {
	if (!chunk.item_id || !chunk.name || !chunk.arguments) return
	const pendingCall = functionCallByItemId.get(chunk.item_id)
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

	constructor(private options: ResponsesWebsocketOptions) { }

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
					const error: Error & { code?: string } = new Error(parsed.error.message || "Responses websocket error")
					error.code = parsed.error.code
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
					`Failed to parse websocket event: ${error instanceof Error ? error.message : String(error)}`,
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

	const message = error instanceof Error ? error.message : String(error)

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

	if (errorCode === "websocket_closed" || errorCode === "websocket_error") {
		return true
	}

	return false
}
