import { APIError } from "openai"

/** Narrow an unknown value to a plain object so deeply-nested provider shapes can be probed. */
function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value)
}

/** Narrow an optional value to a plain object, for probing nested error nodes. */
function narrow(value: unknown): Record<string, unknown> | undefined {
	return isRecord(value) ? value : undefined
}

export function checkContextWindowExceededError(error: unknown): boolean {
	return (
		checkIsOpenAIResponsesContextWindowError(error) ||
		checkIsOpenAIContextWindowError(error) ||
		checkIsOpenRouterContextWindowError(error) ||
		checkIsAnthropicContextWindowError(error) ||
		checkIsCerebrasContextWindowError(error) ||
		checkIsBedrockContextWindowError(error) ||
		checkIsVercelContextWindowError(error)
	)
}

function checkIsOpenAIResponsesContextWindowError(error: unknown): boolean {
	try {
		const root = narrow(error)
		if (!root) return false
		const codes = [
			root.code,
			narrow(root.error)?.code,
			narrow(narrow(root.error)?.error)?.code,
			narrow(root.details)?.code,
			narrow(root.cause)?.code,
		]
		const contextErrorCodes = new Set(["context_length_exceeded", "context_window_exceeded", "input_too_long"])
		if (codes.some((code) => contextErrorCodes.has(String(code).toLowerCase()))) {
			return true
		}

		const messages = [root.message, narrow(root.error)?.message, narrow(narrow(root.error)?.error)?.message]
			.filter((message) => message != null)
			.map((message) => String(message))
		return messages.some((message) => /your input exceeds the context window of this model/i.test(message))
	} catch {
		return false
	}
}

function checkIsOpenRouterContextWindowError(error: unknown): boolean {
	try {
		const root = narrow(error)
		if (!root) return false
		// OpenRouter errors can reach us in two shapes:
		// 1) Direct chunk.error path wrapped as Error with status/code attached.
		// 2) Mid-stream finish_reason="error" path where JSON is stringified into message.
		// So we check structured status first, then JSON-encoded status/code in message text.
		const status = root.status ?? root.code ?? narrow(root.error)?.status ?? narrow(root.response)?.status
		const message: string = String(root.message || narrow(root.error)?.message || "")

		// Handle JSON-encoded errors where status/code is embedded in the message string.
		const statusFromMessage = message.match(/"code":\s*(\d+)/)?.[1] ?? message.match(/"status":\s*(\d+)/)?.[1]
		const finalStatus = statusFromMessage || status

		// Known OpenAI/OpenRouter-style signal (code 400 and message includes "context length")
		const CONTEXT_ERROR_PATTERNS = [
			/\bcontext\s*(?:length|window)\b/i,
			/\bmaximum\s*context\b/i,
			/\b(?:input\s*)?tokens?\s*exceed/i,
			/\btoo\s*many\s*tokens?\b/i,
		] as const

		return String(finalStatus) === "400" && CONTEXT_ERROR_PATTERNS.some((pattern) => pattern.test(message))
	} catch {
		return false
	}
}

// Docs: https://platform.openai.com/docs/guides/error-codes/api-errors
// LengthFinishReasonError is internal to openai/core/error and not re-exported from the package entry,
// so we rely on the APIError + status 400 + message-substring check below.
function checkIsOpenAIContextWindowError(error: unknown): boolean {
	try {
		const KNOWN_CONTEXT_ERROR_SUBSTRINGS = ["token", "context length"] as const

		return (
			Boolean(error) &&
			error instanceof APIError &&
			error.code?.toString() === "400" &&
			KNOWN_CONTEXT_ERROR_SUBSTRINGS.some((substring) => error.message.includes(substring))
		)
	} catch {
		return false
	}
}

function checkIsAnthropicContextWindowError(response: unknown): boolean {
	try {
		const root = narrow(response)
		if (!root) return false
		return narrow(narrow(root.error)?.error)?.type === "invalid_request_error"
	} catch {
		return false
	}
}

function checkIsCerebrasContextWindowError(response: unknown): boolean {
	try {
		const root = narrow(response)
		if (!root) return false
		const status = root.status ?? root.code ?? narrow(root.error)?.status ?? narrow(root.response)?.status
		const message: string = String(root.message || narrow(root.error)?.message || "")

		return String(status) === "400" && message.includes("Please reduce the length of the messages or completion")
	} catch {
		return false
	}
}

function checkIsBedrockContextWindowError(error: unknown): boolean {
	try {
		const root = narrow(error)
		if (!root) return false
		// Bedrock returns ValidationException for context window errors
		const errorType = root.name ?? narrow(root.error)?.type ?? root.__type
		const errorCode = root.code ?? narrow(root.error)?.code ?? narrow(root.$metadata)?.httpStatusCode

		// Handle nested error structures (e.g., through Vercel AI SDK)
		const nestedError = narrow(narrow(root.error)?.param)
		const nestedErrorCode = nestedError?.statusCode ?? narrow(root.details)?.code
		const nestedMessage = nestedError?.message ?? nestedError?.error

		const message: string = String(root.message || narrow(root.error)?.message || nestedMessage || "")

		// Check for ValidationException with HTTP 400
		const isValidationException =
			errorType === "ValidationException" ||
			errorType === "AI_APICallError" ||
			String(errorCode) === "400" ||
			String(nestedErrorCode) === "400" ||
			root.code === "stream_initialization_failed"

		if (!isValidationException) {
			return false
		}

		// Known Bedrock context window error patterns
		const BEDROCK_CONTEXT_PATTERNS = [
			/maximum tokens.*exceeds.*model limit/i,
			/input length and max_tokens exceed context limit/i,
			/context length.*exceeds/i,
			/total number of tokens.*exceeds.*limit/i,
			/requested.*tokens.*exceeds.*limit/i,
			/reduce.*length.*messages.*completion/i,
			/input is too long/i,
		] as const

		return BEDROCK_CONTEXT_PATTERNS.some((pattern) => pattern.test(message))
	} catch {
		return false
	}
}

export function checkIsVercelContextWindowError(error: unknown): boolean {
	try {
		const root = narrow(error)
		if (!root) return false
		const param = narrow(narrow(root.error)?.param)
		const value = narrow(narrow(root.error)?.value)
		const status = root.status ?? param?.statusCode ?? root.statusCode

		// Check for explicit context_length_exceeded code (OpenAI streaming errors)
		const errorCode = narrow(narrow(root.error)?.error)?.code
		if (errorCode === "context_length_exceeded") {
			return true
		}

		const messages = [
			root.message,
			narrow(root.error)?.message,
			param?.message,
			param?.error,
			narrow(narrow(root.error)?.error)?.message,
			value?.error_message, // Alibaba Qwen validation errors
		].filter((msg) => msg != null)

		if (messages.length === 0) {
			return false
		}

		// Must be a 400 error OR have 400 embedded in error_message (Alibaba Qwen case)
		const hasValidStatus = String(status) === "400"
		const errorMessage = value?.error_message
		const has400InMessage =
			errorMessage &&
			typeof errorMessage === "string" &&
			(errorMessage.includes('"code":400') || errorMessage.includes('"code": 400'))

		if (!hasValidStatus && !has400InMessage) {
			return false
		}

		const CONTEXT_ERROR_PATTERNS = [
			/input is too long/i,
			/input token count exceeds.*maximum.*tokens? allowed/i,
			/input exceeds.*context window/i,
			/requested input length.*exceeds.*maximum input length/i,
			/prompt is too long.*tokens?\s*>\s*\d+\s*maximum/i,
			/\bcontext\s*(?:length|window)\b.*exceed/i,
			/\bmaximum\s*context\b/i,
			/\b(?:input\s*)?tokens?\s*exceed/i,
			/too\s*many\s*tokens/i,
		] as const

		return messages
			.map((msg) => String(msg).toLowerCase())
			.some((message) => CONTEXT_ERROR_PATTERNS.some((pattern) => pattern.test(message)))
	} catch {
		return false
	}
}
