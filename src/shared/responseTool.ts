import type { Card } from "./ExtensionMessage"
import { parsePartialArrayString } from "./array"

export const RESPOND_TOOL_NAME = "respond" as const
export enum ResponseParameter {
	OPERATION = "operation",
	TEXT = "text",
	OPTIONS = "options",
}

export enum LegacyResponseParameter {
	MESSAGE = "message",
	RESULT = "result",
	RESPONSE = "response",
	QUESTION = "question",
	NEEDS_MORE_EXPLORATION = "needs_more_exploration",
}

interface ResponseToolCall {
	name: string
	params: {
		[ResponseParameter.OPERATION]?: unknown
		[ResponseParameter.TEXT]?: unknown
		[LegacyResponseParameter.MESSAGE]?: unknown
		[LegacyResponseParameter.RESULT]?: unknown
		[LegacyResponseParameter.RESPONSE]?: unknown
		[LegacyResponseParameter.QUESTION]?: unknown
		[ResponseParameter.OPTIONS]?: unknown
		[LegacyResponseParameter.NEEDS_MORE_EXPLORATION]?: unknown
	}
}

export enum ResponseOperation {
	PROGRESS = "progress",
	COMPLETE = "complete",
	PLAN = "plan",
	QUESTION = "question",
}
export const RESPONSE_OPERATIONS = Object.values(ResponseOperation)
const RESPONSE_PARAMETERS = new Set<string>(Object.values(ResponseParameter))

export enum LegacyResponseTool {
	PROGRESS = "say",
	COMPLETE = "attempt_completion",
	PLAN = "plan_mode_respond",
	QUESTION = "ask_followup_question",
}

export enum ResponseCardHeader {
	QUESTION = "Question",
	QUESTION_DECLINED = "Question declined",
	ANSWERED = "Answered",
	PROPOSED_PLAN = "Proposed Plan",
	PLAN_ACCEPTED = "Plan Accepted",
}

export enum PlanInteractionResponse {
	MODE_TOGGLE = "PLAN_MODE_TOGGLE_RESPONSE",
}

export const LEGACY_RESPONSE_TOOLS = {
	[LegacyResponseTool.PROGRESS]: ResponseOperation.PROGRESS,
	[LegacyResponseTool.COMPLETE]: ResponseOperation.COMPLETE,
	[LegacyResponseTool.PLAN]: ResponseOperation.PLAN,
	[LegacyResponseTool.QUESTION]: ResponseOperation.QUESTION,
} as const satisfies Record<string, ResponseOperation>

export type LegacyResponseToolName = keyof typeof LEGACY_RESPONSE_TOOLS

const LEGACY_RESPONSE_TEXT_PARAMETERS = {
	[ResponseOperation.PROGRESS]: LegacyResponseParameter.MESSAGE,
	[ResponseOperation.COMPLETE]: LegacyResponseParameter.RESULT,
	[ResponseOperation.PLAN]: LegacyResponseParameter.RESPONSE,
	[ResponseOperation.QUESTION]: LegacyResponseParameter.QUESTION,
} as const satisfies Record<ResponseOperation, LegacyResponseParameter>

export interface ResponseArguments {
	operation: ResponseOperation
	text: string
	options?: string[]
}

export class ResponseShapeError extends Error { }

export function validateResponseShape(args: unknown): ResponseArguments {
	if (!args || typeof args !== "object" || Array.isArray(args)) throw new ResponseShapeError("Expected an object.")

	const input = args as Record<string, unknown>
	const operation = input[ResponseParameter.OPERATION]
	if (typeof operation !== "string" || !RESPONSE_OPERATIONS.includes(operation as ResponseOperation)) {
		throw new ResponseShapeError(`Missing or invalid 'operation'. Expected one of: ${RESPONSE_OPERATIONS.join(", ")}.`)
	}
	if (input[LegacyResponseParameter.NEEDS_MORE_EXPLORATION] !== undefined) {
		throw new ResponseShapeError(
			`'${LegacyResponseParameter.NEEDS_MORE_EXPLORATION}' is not supported. Continue exploring with tools instead.`,
		)
	}
	const unsupportedParameter = Object.keys(input).find((parameter) => !RESPONSE_PARAMETERS.has(parameter))
	if (unsupportedParameter) throw new ResponseShapeError(`Unsupported response parameter: ${unsupportedParameter}`)

	const text = input[ResponseParameter.TEXT]
	if (typeof text !== "string" || !text.trim()) throw new ResponseShapeError("Missing required parameter: text")

	const normalizedOperation = operation as ResponseOperation
	const options = normalizeResponseOptions(input[ResponseParameter.OPTIONS])
	if (normalizedOperation !== ResponseOperation.QUESTION && options !== undefined) {
		throw new ResponseShapeError(`'options' is valid only for the 'question' response operation.`)
	}
	if (normalizedOperation === ResponseOperation.QUESTION && options) validateQuestionOptions(options)
	return {
		operation: normalizedOperation,
		text,
		...(options ? { options } : {}),
	}
}

function normalizeResponseOptions(value: unknown): string[] | undefined {
	if (value === undefined || value === null) return undefined
	return typeof value === "string" ? parsePartialArrayString(value) : (value as string[])
}

function validateQuestionOptions(options: string[]): void {
	if (!Array.isArray(options)) throw new ResponseShapeError("'options' must be an array of strings.")
	if (options.length < 2 || options.length > 5) {
		throw new ResponseShapeError("'options' must contain between 2 and 5 answers.")
	}
	if (options.some((option) => typeof option !== "string" || !option.trim())) {
		throw new ResponseShapeError("Every question option must be a non-empty string.")
	}
	const normalized = options.map((option) => option.trim())
	if (new Set(normalized).size !== normalized.length) {
		throw new ResponseShapeError("Question options must be unique.")
	}
	if (options.some((option) => /\b(?:switch|toggle|enter|move)\b.*\bact mode\b/i.test(option))) {
		throw new ResponseShapeError("Question options must not contain an Act Mode toggle choice.")
	}
}

export interface ResponseCardInput extends ResponseArguments {
	[key: string]: unknown
	tool: typeof RESPOND_TOOL_NAME
	operation: Exclude<ResponseOperation, ResponseOperation.PROGRESS>
}

export function responseOperationFromToolCall(call: ResponseToolCall): ResponseOperation | undefined {
	const operation = call.params[ResponseParameter.OPERATION]
	if (call.name === RESPOND_TOOL_NAME && RESPONSE_OPERATIONS.includes(operation as ResponseOperation)) {
		return operation as ResponseOperation
	}
	return LEGACY_RESPONSE_TOOLS[call.name as LegacyResponseToolName]
}

export function isCompletionResponseCall(call: ResponseToolCall): boolean {
	return responseOperationFromToolCall(call) === ResponseOperation.COMPLETE
}

export function canonicalizeResponseToolCall(call: ResponseToolCall, rejectRemovedFields = true): boolean {
	const operation = LEGACY_RESPONSE_TOOLS[call.name as LegacyResponseToolName]
	if (!operation) return false
	if (call.params[LegacyResponseParameter.NEEDS_MORE_EXPLORATION] !== undefined && !rejectRemovedFields) return false
	if (call.params[LegacyResponseParameter.NEEDS_MORE_EXPLORATION] !== undefined) {
		throw new ResponseShapeError(
			`'${LegacyResponseParameter.NEEDS_MORE_EXPLORATION}' is not supported. Continue exploring with tools instead.`,
		)
	}

	const textField = LEGACY_RESPONSE_TEXT_PARAMETERS[operation]
	const fallbackText =
		operation === ResponseOperation.COMPLETE ? call.params[LegacyResponseParameter.RESPONSE] : undefined
	call.name = RESPOND_TOOL_NAME
	call.params = {
		operation,
		text: call.params[textField] ?? fallbackText,
		...(call.params.options !== undefined ? { options: call.params.options } : {}),
	}
	return true
}

export function responseOperationFromCard(card: Pick<Card, "header" | "toolName" | "rawInput">): ResponseOperation | undefined {
	const rawTool = card.rawInput?.tool
	if (
		(card.toolName === RESPOND_TOOL_NAME || rawTool === RESPOND_TOOL_NAME) &&
		RESPONSE_OPERATIONS.includes(card.rawInput?.[ResponseParameter.OPERATION] as ResponseOperation)
	) {
		return card.rawInput![ResponseParameter.OPERATION] as ResponseOperation
	}
	for (const metadataTool of [card.toolName, rawTool]) {
		if (typeof metadataTool !== "string") continue
		const legacyOperation = LEGACY_RESPONSE_TOOLS[metadataTool as LegacyResponseToolName]
		if (legacyOperation) return legacyOperation
	}
	return card.header === ResponseCardHeader.PROPOSED_PLAN ? ResponseOperation.PLAN : undefined
}

export function isQuestionResponseCard(card: Pick<Card, "header" | "toolName" | "rawInput">): boolean {
	return responseOperationFromCard(card) === ResponseOperation.QUESTION
}

export function isPlanResponseCard(card: Pick<Card, "header" | "toolName" | "rawInput">): boolean {
	return responseOperationFromCard(card) === ResponseOperation.PLAN
}

export function responseCardInput(
	operation: ResponseCardInput["operation"],
	text: string,
	options?: string[],
): ResponseCardInput {
	return { tool: RESPOND_TOOL_NAME, operation, text, ...(options ? { options } : {}) }
}
