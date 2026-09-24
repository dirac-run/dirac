import { strict as assert } from "node:assert"
import { describe, it } from "mocha"
import { z } from "zod"
import { JsonParseError, safeParseJson } from "../safe-json-parse"

const recordSchema = z.object({ path: z.string() })

// Malformed-JSON corpus shared by every boundary site: truncated payload,
// BOM-prefixed payload, unbalanced quotes, wrong top-level type.
const MALFORMED_CORPUS = [
	{ name: "truncated payload", raw: '{"path": "src/ut' },
	{ name: "BOM-prefixed payload", raw: '﻿{"path": "x"}' },
	{ name: "unbalanced quotes", raw: '{"path: "x"}' },
	{ name: "unquoted keys", raw: '{path: "x"}' },
	{ name: "empty string", raw: "" },
	{ name: "whitespace only", raw: "   \n  " },
]

describe("safeParseJson", () => {
	for (const { name, raw } of MALFORMED_CORPUS) {
		it(`throws JsonParseError with payload excerpt for ${name}`, () => {
			assert.throws(
				() => safeParseJson(recordSchema, raw, "test boundary"),
				(error: unknown) => {
					assert.ok(error instanceof JsonParseError)
					assert.ok(error.message.includes("malformed JSON"))
					assert.ok(error.message.includes("payload:"))
					return true
				},
			)
		})
	}

	it("throws on valid JSON with the wrong top-level type", () => {
		assert.throws(
			() => safeParseJson(recordSchema, '"just a string"', "test boundary"),
			/schema mismatch.*payload:/i,
		)
	})

	it("throws on valid JSON with the wrong shape and names the field", () => {
		assert.throws(
			() => safeParseJson(recordSchema, '{"path": 42}', "test boundary"),
			(error: unknown) => {
				assert.ok(error instanceof JsonParseError)
				assert.ok(error.message.includes("'path'"), "should name the failing field")
				assert.ok(error.message.includes("payload:"))
				return true
			},
		)
	})

	it("truncates very long payloads in the excerpt", () => {
		const raw = `{"path": "${"x".repeat(500)}` // unterminated + long
		assert.throws(
			() => safeParseJson(recordSchema, raw, "test boundary"),
			(error: unknown) => {
				assert.ok(error instanceof JsonParseError)
				assert.ok(error.payload.length < 300, "excerpt must be bounded")
				assert.ok(error.payload.includes("chars total"))
				return true
			},
		)
	})

	it("returns parsed data for a valid payload", () => {
		const result = safeParseJson(recordSchema, '{"path": "src/main.ts"}', "test boundary")
		assert.deepEqual(result, { path: "src/main.ts" })
	})

	it("strips unknown keys per zod object semantics", () => {
		const result = safeParseJson(recordSchema, '{"path": "x", "extra": true}', "test boundary")
		assert.deepEqual(result, { path: "x" })
	})
})
