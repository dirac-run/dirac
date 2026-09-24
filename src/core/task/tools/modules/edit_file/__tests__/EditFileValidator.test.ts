import { strict as assert } from "node:assert"
import { describe, it } from "mocha"
import type { IToolEnvironment } from "../../../interfaces/IToolEnvironment"
import { EditFileValidator } from "../EditFileValidator"
import type { Edit, FileEdit } from "../types"

function makeEnv(): { env: IToolEnvironment; mistakes: () => number } {
	const taskState = { consecutiveMistakeCount: 0 }
	const env = {
		config: { taskState },
		orchestration: {
			setTaskState: (key: string, value: unknown) => {
				;(taskState as Record<string, unknown>)[key] = value
			},
		},
	} as unknown as IToolEnvironment
	return { env, mistakes: () => taskState.consecutiveMistakeCount }
}

const VALID_EDIT: Edit = { anchor: "a1", edit_type: "replace", text: "new" }

// Model-side `edits` often arrives stringified or misshapen — cast through unknown to exercise validation.
const asFiles = (value: unknown): FileEdit[] => value as FileEdit[]

// Asserts the validator rejected the input and returns the message for content checks.
function expectError(result: FileEdit[] | string): string {
	assert.equal(typeof result, "string", "expected an error string")
	return result as string
}

describe("EditFileValidator malformed-JSON boundaries", () => {
	const corpus = [
		{ name: "truncated payload", files: '[{"path": "a.ts", "edits": [' },
		{ name: "unbalanced quotes", files: '[{"path: "a.ts"}]' },
		{ name: "non-JSON text", files: "not json at all" },
		{ name: "empty string", files: "" },
	]

	for (const { name, files } of corpus) {
		it(`returns an error naming 'files' for ${name}`, () => {
			const { env } = makeEnv()
			const message = expectError(new EditFileValidator().validateFiles({ files }, env))
			assert.ok(message.includes("files"), "error should name the files parameter")
			assert.ok(message.includes("invalid JSON") || message.includes("payload"), "error should carry parse detail")
		})
	}

	it("increments consecutiveMistakeCount on malformed input", () => {
		const { env, mistakes } = makeEnv()
		new EditFileValidator().validateFiles({ files: "not json" }, env)
		assert.equal(mistakes(), 1)
	})

	it("rejects valid JSON that is not an array", () => {
		const { env } = makeEnv()
		const message = expectError(new EditFileValidator().validateFiles({ files: '{"path":"a.ts"}' }, env))
		assert.ok(message.includes("array"), "error should mention array")
	})

	it("rejects a file entry missing a path", () => {
		const { env } = makeEnv()
		const message = expectError(new EditFileValidator().validateFiles({ files: asFiles([{ edits: [VALID_EDIT] }]) }, env))
		assert.ok(message.includes("files[0"))
	})

	it("rejects edits arriving as a malformed JSON string", () => {
		const { env } = makeEnv()
		const files = asFiles([{ path: "a.ts", edits: "not-json" }])
		const message = expectError(new EditFileValidator().validateFiles({ files }, env))
		assert.ok(message.includes("files[0].edits"))
	})

	it("rejects an edits string that parses to a non-array", () => {
		const { env } = makeEnv()
		const files = asFiles([{ path: "a.ts", edits: '"oops"' }])
		const message = expectError(new EditFileValidator().validateFiles({ files }, env))
		assert.ok(message.includes("files[0].edits"))
	})

	it("passes wrong-shape edit objects through for per-edit failure downstream", () => {
		// Batch-level validation only requires a non-empty edits array; EditExecutor fails
		// malformed edits individually so one bad edit does not reject the whole batch.
		const { env } = makeEnv()
		const badEdit = { anchor: 42 }
		const files = asFiles([{ path: "a.ts", edits: [badEdit] }])
		const result = new EditFileValidator().validateFiles({ files }, env)
		assert.deepEqual(result, [{ path: "a.ts", edits: [badEdit] }])
	})

	it("parses stringified edits and normalizes the batch", () => {
		const { env } = makeEnv()
		const files = asFiles([{ path: "a.ts", edits: JSON.stringify([VALID_EDIT]) }])
		const result = new EditFileValidator().validateFiles({ files }, env)
		assert.deepEqual(result, [{ path: "a.ts", edits: [VALID_EDIT] }])
	})

	it("accepts a well-formed files array directly", () => {
		const { env } = makeEnv()
		const result = new EditFileValidator().validateFiles({ files: [{ path: "a.ts", edits: [VALID_EDIT] }] }, env)
		assert.deepEqual(result, [{ path: "a.ts", edits: [VALID_EDIT] }])
	})
})
