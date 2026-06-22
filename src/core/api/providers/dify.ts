import { buildExternalBasicHeaders } from "@/services/EnvUtils"
import { DiracStorageMessage } from "@/shared/messages/content"
import { fetch } from "@/shared/net"
import { Logger } from "@/shared/services/Logger"
import { ModelInfo } from "../../../shared/api"
import { ApiHandler } from "../index"
import { ApiStream } from "../transform/stream"

interface DifyHandlerOptions {
	difyApiKey?: string
	difyBaseUrl?: string
}

// Dify API Response Types
export interface DifyFileResponse {
	id: string
	name: string
	size: number
	extension: string
	mime_type: string
	created_by: string
	created_at: number
}

export interface DifyMessage {
	id: string
	conversation_id: string
	inputs: Record<string, any>
	query: string
	message_files: Array<{
		id: string
		type: string
		url: string
		belongs_to: string
	}>
	answer: string
	created_at: number
	feedback?: {
		rating: string
	}
	retriever_resources?: any[]
}

interface DifyHistoryResponse {
	data: DifyMessage[]
	has_more: boolean
	limit: number
}

interface DifyConversation {
	id: string
	name: string
	inputs: Record<string, any>
	status: string
	introduction: string
	created_at: number
	updated_at: number
}

interface DifyConversationsResponse {
	data: DifyConversation[]
	has_more: boolean
	limit: number
}

interface DifyConversationResponse {
	id: string
	name: string
	inputs: Record<string, any>
	status: string
	introduction: string
	created_at: number
	updated_at: number
}

export class DifyHandler implements ApiHandler {
	private options: DifyHandlerOptions
	private baseUrl: string
	private apiKey: string
	private conversationId: string | null = null
	private currentTaskId: string | null = null
	private abortController: AbortController | null = null

	constructor(options: DifyHandlerOptions) {
		this.options = options
		this.apiKey = options.difyApiKey || ""
		this.baseUrl = options.difyBaseUrl || ""

		if (!this.apiKey) {
			throw new Error("Dify API key is required")
		}
		if (!this.baseUrl) {
			throw new Error("Dify base URL is required")
		}
	}

	async *createMessage(systemPrompt: string, messages: DiracStorageMessage[]): ApiStream {
		// Convert messages to Dify format
		const query = this.convertMessagesToQuery(systemPrompt, messages)
		this.abortController = new AbortController()
		const requestBody = {
			inputs: {},
			query: query,
			response_mode: "streaming",
			conversation_id: this.conversationId || "",
			user: "dirac-user", // A unique user identifier
			files: [],
		}

		const fullUrl = `${this.baseUrl}/chat-messages`

		let response: Response
		try {
			response = await fetch(fullUrl, {
				method: "POST",
				headers: this.jsonHeaders(),
				body: JSON.stringify(requestBody),
				signal: this.abortController?.signal,
			})
		} catch (error: any) {
			const cause = error.cause ? ` | Cause: ${error.cause}` : ""
			throw new Error(`Dify API network error: ${error.message}${cause}`)
		}

		const headersObj: Record<string, string> = {}
		response.headers.forEach((value, key) => {
			headersObj[key] = value
		})

		if (!response.ok) {
			const errorText = await response.text()
			throw new Error(`Dify API error: ${response.status} ${response.statusText} - ${errorText}`)
		}

		if (!response.body) {
			throw new Error("No response body from Dify API")
		}

		const reader = response.body.getReader()
		const decoder = new TextDecoder()
		let buffer = ""
		let fullText = ""
		let hasYieldedContent = false
		const processedEvents: string[] = []
		const lastEventTime = Date.now()

		try {
			while (true) {
				const { done, value } = await reader.read()
				if (done) break

				buffer += decoder.decode(value, { stream: true })
				const lines = buffer.split("\n")
				buffer = lines.pop() || ""

				for (const line of lines) {
					const ctx = { fullText, hasYieldedContent }
					if (line.startsWith("data: ")) {
						const data = line.slice(6).trim()
						if (data === "[DONE]") break
						if (data === "") continue
						try {
							const result = this.parseDifySseEvent(JSON.parse(data), ctx, processedEvents, fullUrl)
							fullText = result.fullText
							hasYieldedContent = result.hasYieldedContent
							yield* result.chunks
							if (result.done) return
						} catch (e) {
							Logger.warn("Dify: failed to parse SSE JSON:", data, e)
						}
					} else if (line.trim() !== "") {
						try {
							const result = this.parseDifyDirectJson(JSON.parse(line.trim()), ctx, processedEvents)
							fullText = result.fullText
							hasYieldedContent = result.hasYieldedContent
							yield* result.chunks
							if (result.done) return
						} catch (e) {
							// Non-JSON lines (comments, heartbeats) are expected in SSE streams
							Logger.debug("Dify: non-JSON SSE line:", line.trim(), e)
						}
					}
				}
			}

			if (!hasYieldedContent) {
				if (fullText.trim()) {
					yield { type: "text", text: fullText }
				} else {
					throw new Error(
						`Dify API did not provide any assistant messages. ` +
							`Events processed: [${processedEvents.join(", ")}]. ` +
							`Check your Dify application configuration and ensure it's properly set up to return responses. ` +
							`API URL: ${fullUrl}. Conversation ID: ${this.conversationId || "none"}.`,
					)
				}
			}
		} finally {
			reader.releaseLock()
		}
	}

	// Parses a Dify SSE event JSON into chunks. Returns updated state and whether the stream is done.
	private parseDifySseEvent(
		parsed: any,
		ctx: { fullText: string; hasYieldedContent: boolean },
		processedEvents: string[],
		_fullUrl: string,
	): { chunks: any[]; fullText: string; hasYieldedContent: boolean; done: boolean } {
		processedEvents.push(parsed.event || "unknown")
		if (parsed.conversation_id && !this.conversationId) this.conversationId = parsed.conversation_id
		const chunks: any[] = []
		let { fullText, hasYieldedContent } = ctx

		if (parsed.event === "message") {
			if (typeof parsed.answer === "string") {
				fullText = parsed.answer
				chunks.push({ type: "text", text: fullText })
				hasYieldedContent = true
			}
		} else if (parsed.event === "message_replace") {
			if (parsed.answer) {
				fullText = parsed.answer
				chunks.push({ type: "text", text: fullText })
				hasYieldedContent = true
			}
		} else if (parsed.event === "message_end") {
			if (fullText) {
				chunks.push({ type: "text", text: fullText })
				hasYieldedContent = true
			}
			if (parsed.usage)
				chunks.push({
					type: "usage",
					inputTokens: parsed.usage.prompt_tokens || 0,
					outputTokens: parsed.usage.completion_tokens || parsed.usage.total_tokens || 0,
					totalCost: parsed.usage.total_price || 0,
				})
			return { chunks, fullText, hasYieldedContent, done: true }
		} else if (parsed.event === "error") {
			throw new Error(`Dify API error: ${parsed.message || "Unknown error"}`)
		} else if (["workflow_started", "workflow_finished", "node_started", "node_finished", "ping"].includes(parsed.event)) {
			// Informational events — no action needed
		} else {
			const content = parsed.text || parsed.content || parsed.answer
			if (content) {
				fullText += content
				chunks.push({ type: "text", text: fullText })
				hasYieldedContent = true
			}
		}
		return { chunks, fullText, hasYieldedContent, done: false }
	}

	// Parses a direct (non-SSE) JSON line into chunks. Fallback for non-standard Dify responses.
	private parseDifyDirectJson(
		parsed: any,
		ctx: { fullText: string; hasYieldedContent: boolean },
		processedEvents: string[],
	): { chunks: any[]; fullText: string; hasYieldedContent: boolean; done: boolean } {
		processedEvents.push(parsed.event || "direct-json")
		const chunks: any[] = []
		let { fullText, hasYieldedContent } = ctx

		if (parsed.event === "message" && parsed.answer) {
			fullText += parsed.answer
			chunks.push({ type: "text", text: fullText })
			hasYieldedContent = true
		} else if (parsed.event === "message_end") {
			if (fullText) {
				chunks.push({ type: "text", text: fullText })
				hasYieldedContent = true
			}
			return { chunks, fullText, hasYieldedContent, done: true }
		} else if (parsed.event === "error") {
			throw new Error(`Dify API error: ${parsed.message || "Unknown error"}`)
		} else if (parsed.answer || parsed.text || parsed.content) {
			fullText += parsed.answer || parsed.text || parsed.content
			chunks.push({ type: "text", text: fullText })
			hasYieldedContent = true
		}
		return { chunks, fullText, hasYieldedContent, done: false }
	}

	private convertMessagesToQuery(systemPrompt: string, messages: DiracStorageMessage[]): string {
		// Dify's context is managed by `conversation_id`. The `query` should be the last user message.
		// The system prompt is typically configured in the Dify App itself.
		const lastUserMessage = messages.filter((m) => m.role === "user").pop()

		if (!lastUserMessage) {
			return "" // Should not happen in normal flow
		}

		const userQuery = Array.isArray(lastUserMessage.content)
			? lastUserMessage.content.map((c) => ("text" in c ? c.text : "")).join("\n")
			: (lastUserMessage.content as string)

		// Only prepend the system prompt if it's the very first message of a new conversation.
		if (!this.conversationId && systemPrompt) {
			return `${systemPrompt}\n\n---\n\n${userQuery}`
		}

		return userQuery
	}

	getModel(): { id: string; info: ModelInfo } {
		return {
			id: "dify-workflow",
			info: {
				maxTokens: 8192,
				contextWindow: 128000,
				supportsImages: true,
				supportsPromptCache: false,
				inputPrice: 0,
				outputPrice: 0,
				description: "Dify workflow - model selection is configured in your Dify application",
			},
		}
	}

	// Additional Dify API Methods

	/**
	 * Upload a file for use in conversations
	 * @param file File buffer to upload
	 * @param filename Name of the file
	 * @param user User identifier (defaults to "dirac-user")
	 * @returns Promise with file upload response
	 */
	async uploadFile(file: Buffer, filename: string, user = "dirac-user"): Promise<DifyFileResponse> {
		const formData = new FormData()
		formData.append("file", new Blob([new Uint8Array(file)]), filename)
		formData.append("user", user)

		const response = await fetch(`${this.baseUrl}/files/upload`, {
			method: "POST",
			headers: this.headers(),
			body: formData,
		})

		if (!response.ok) {
			const errorText = await response.text()
			throw new Error(`Dify file upload error: ${response.status} ${response.statusText} - ${errorText}`)
		}

		return response.json()
	}

	/**
	 * Stop generation for a specific task
	 * @param taskId Task ID from streaming response
	 * @param user User identifier (defaults to "dirac-user")
	 * @returns Promise that resolves when generation is stopped
	 */
	async stopGeneration(taskId: string, user = "dirac-user"): Promise<void> {
		const response = await fetch(`${this.baseUrl}/chat-messages/${taskId}/stop`, {
			method: "POST",
			headers: this.jsonHeaders(),
			body: JSON.stringify({ user }),
		})

		if (!response.ok) {
			const errorText = await response.text()
			throw new Error(`Dify stop generation error: ${response.status} ${response.statusText} - ${errorText}`)
		}
	}

	/**
	 * Get conversation history messages with pagination
	 * @param conversationId Conversation ID
	 * @param user User identifier (defaults to "dirac-user")
	 * @param firstId First message ID for pagination (optional)
	 * @param limit Number of messages to return (default: 20)
	 * @returns Promise with conversation history
	 */
	async getConversationHistory(
		conversationId: string,
		user = "dirac-user",
		firstId?: string,
		limit = 20,
	): Promise<DifyHistoryResponse> {
		const params = new URLSearchParams({ user, limit: limit.toString() })
		if (firstId) {
			params.append("first_id", firstId)
		}

		const response = await fetch(`${this.baseUrl}/conversations/${conversationId}/messages?${params}`, {
			headers: this.headers(),
		})

		if (!response.ok) {
			const errorText = await response.text()
			throw new Error(`Dify get conversation history error: ${response.status} ${response.statusText} - ${errorText}`)
		}

		return response.json()
	}

	/**
	 * Get list of conversations for a user
	 * @param user User identifier (defaults to "dirac-user")
	 * @param lastId Last conversation ID for pagination (optional)
	 * @param limit Number of conversations to return (default: 20)
	 * @param sortBy Sort field (default: "-updated_at")
	 * @returns Promise with conversations list
	 */
	async getConversations(
		user = "dirac-user",
		lastId?: string,
		limit = 20,
		sortBy = "-updated_at",
	): Promise<DifyConversationsResponse> {
		const params = new URLSearchParams({
			user,
			limit: limit.toString(),
			sort_by: sortBy,
		})
		if (lastId) {
			params.append("last_id", lastId)
		}

		const response = await fetch(`${this.baseUrl}/conversations?${params}`, {
			headers: this.headers(),
		})

		if (!response.ok) {
			const errorText = await response.text()
			throw new Error(`Dify get conversations error: ${response.status} ${response.statusText} - ${errorText}`)
		}

		return response.json()
	}

	/**
	 * Delete a conversation
	 * @param conversationId Conversation ID to delete
	 * @param user User identifier (defaults to "dirac-user")
	 * @returns Promise that resolves when conversation is deleted
	 */
	async deleteConversation(conversationId: string, user = "dirac-user"): Promise<void> {
		const response = await fetch(`${this.baseUrl}/conversations/${conversationId}`, {
			method: "DELETE",
			headers: this.jsonHeaders(),
			body: JSON.stringify({ user }),
		})

		if (!response.ok) {
			const errorText = await response.text()
			throw new Error(`Dify delete conversation error: ${response.status} ${response.statusText} - ${errorText}`)
		}
	}

	/**
	 * Rename a conversation
	 * @param conversationId Conversation ID to rename
	 * @param user User identifier (defaults to "dirac-user")
	 * @param name New conversation name (optional if auto_generate is true)
	 * @param autoGenerate Whether to auto-generate the name (default: false)
	 * @returns Promise with updated conversation details
	 */
	async renameConversation(
		conversationId: string,
		user = "dirac-user",
		name?: string,
		autoGenerate = false,
	): Promise<DifyConversationResponse> {
		const body: any = { user, auto_generate: autoGenerate }
		if (name) {
			body.name = name
		}

		const response = await fetch(`${this.baseUrl}/conversations/${conversationId}/name`, {
			method: "POST",
			headers: this.jsonHeaders(),
			body: JSON.stringify(body),
		})

		if (!response.ok) {
			const errorText = await response.text()
			throw new Error(`Dify rename conversation error: ${response.status} ${response.statusText} - ${errorText}`)
		}

		return response.json()
	}

	/**
	 * Submit feedback for a message
	 * @param messageId Message ID to provide feedback for
	 * @param rating Rating: "like" or "dislike"
	 * @param content Optional feedback content
	 * @param user User identifier (defaults to "dirac-user")
	 * @returns Promise that resolves when feedback is submitted
	 */
	async submitMessageFeedback(
		messageId: string,
		rating: "like" | "dislike",
		content?: string,
		user = "dirac-user",
	): Promise<void> {
		const body: any = { rating, user }
		if (content) {
			body.content = content
		}

		const response = await fetch(`${this.baseUrl}/messages/${messageId}/feedbacks`, {
			method: "POST",
			headers: this.jsonHeaders(),
			body: JSON.stringify(body),
		})

		if (!response.ok) {
			const errorText = await response.text()
			throw new Error(`Dify submit feedback error: ${response.status} ${response.statusText} - ${errorText}`)
		}
	}

	/**
	 * Get current conversation ID
	 * @returns Current conversation ID or null
	 */
	getCurrentConversationId(): string | null {
		return this.conversationId
	}

	/**
	 * Set conversation ID for continuing existing conversations
	 * @param conversationId Conversation ID to set
	 */
	setConversationId(conversationId: string): void {
		this.conversationId = conversationId
	}

	/**
	 * Reset conversation ID to start a new conversation
	 */
	resetConversation(): void {
		this.conversationId = null
		this.currentTaskId = null
	}

	abort(): void {
		this.abortController?.abort()
		this.abortController = null
	}

	private jsonHeaders() {
		return {
			...this.headers(),
			"Content-Type": "application/json",
		}
	}

	private headers() {
		const externalHeaders = buildExternalBasicHeaders()
		return {
			...externalHeaders,
			Authorization: `Bearer ${this.apiKey}`,
		}
	}
}
