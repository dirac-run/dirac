import { z } from "zod"
import { getErrorMessage } from "./errors"

const PAYLOAD_EXCERPT_LENGTH = 200

function payloadExcerpt(raw: string): string {
	const compact = raw.trim()
	if (compact.length <= PAYLOAD_EXCERPT_LENGTH) {
		return compact
	}
	return `${compact.slice(0, PAYLOAD_EXCERPT_LENGTH)}… (${compact.length} chars total)`
}

/** Thrown by {@link safeParseJson}; always carries an excerpt of the offending payload. */
export class JsonParseError extends Error {
	readonly payload: string

	constructor(message: string, raw: string, options?: { cause?: unknown }) {
		super(message, options)
		this.name = "JsonParseError"
		this.payload = payloadExcerpt(raw)
	}
}

/**
 * `JSON.parse` for untrusted boundaries (LLM output, user-supplied files).
 *
 * Throws {@link JsonParseError} carrying a payload excerpt on malformed JSON or
 * schema mismatch — callers must never substitute a silent default for
 * LLM-facing input.
 */
export function safeParseJson<S extends z.ZodTypeAny>(schema: S, raw: string, label: string): z.output<S> {
	let parsed: unknown
	try {
		parsed = JSON.parse(raw)
	} catch (error) {
		throw new JsonParseError(`${label}: malformed JSON (${getErrorMessage(error)}) — payload: ${payloadExcerpt(raw)}`, raw, {
			cause: error,
		})
	}

	const result = schema.safeParse(parsed)
	if (!result.success) {
		const issue = result.error.issues[0]
		const where = issue && issue.path.length > 0 ? ` at '${issue.path.join(".")}'` : ""
		throw new JsonParseError(
			`${label}: schema mismatch${where} — ${issue?.message ?? "unknown"}. payload: ${payloadExcerpt(raw)}`,
			raw,
			{ cause: result.error },
		)
	}
	return result.data
}
