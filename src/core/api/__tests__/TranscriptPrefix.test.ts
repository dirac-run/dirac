import { strict as assert } from "node:assert"
import { describe, it } from "mocha"
import { extendTranscriptPrefix, TranscriptIntegrityError } from "../TranscriptPrefix"

const header = { systemPrompt: "fixed", tools: [{ name: "read" }], model: "model" }
const history = [{ role: "user", content: "first" }, { role: "assistant", content: "second" }]

describe("append-only transcript prefix", () => {
	it("accepts retries and arbitrarily growing append-only sequences", () => {
		let prefix = extendTranscriptPrefix(undefined, header, history)
		const id = prefix.id
		const messages = structuredClone(history)
		for (let index = 0; index < 100; index++) {
			prefix = extendTranscriptPrefix(JSON.parse(JSON.stringify(prefix)), header, messages)
			assert.equal(prefix.id, id)
			messages.push({ role: index % 2 ? "assistant" : "user", content: `tail ${index}` })
			prefix = extendTranscriptPrefix(prefix, header, messages)
			assert.equal(prefix.id, id)
		}
	})

	for (const mutation of [
		(messages: typeof history) => { messages[0].content = "edited" },
		(messages: typeof history) => { messages.splice(1, 0, { role: "user", content: "inserted" }) },
		(messages: typeof history) => { messages.reverse() },
		(messages: typeof history) => { messages.pop() },
	]) {
		it("rejects edits, insertion, reordering, and deletion without advancing the baseline", () => {
			const prefix = extendTranscriptPrefix(undefined, header, history)
			const snapshot = structuredClone(prefix)
			const changed = structuredClone(history)
			mutation(changed)
			assert.throws(() => extendTranscriptPrefix(prefix, header, changed), TranscriptIntegrityError)
			assert.deepEqual(prefix, snapshot)
			assert.equal(extendTranscriptPrefix(prefix, header, history).id, prefix.id)
		})
	}

	it("rejects changes to instructions, tools, and model", () => {
		const prefix = extendTranscriptPrefix(undefined, header, history)
		for (const changed of [{ ...header, systemPrompt: "live state" }, { ...header, tools: [] }, { ...header, model: "other" }]) {
			assert.throws(() => extendTranscriptPrefix(prefix, changed, history), TranscriptIntegrityError)
		}
	})

	it("condensation creates a distinct transcript and leaves the sealed predecessor intact", () => {
		const old = extendTranscriptPrefix(undefined, header, history)
		const snapshot = structuredClone(old)
		const condensed = [{ role: "user", content: "summary" }]
		const next = extendTranscriptPrefix(undefined, header, condensed, old.id)
		assert.notEqual(next.id, old.id)
		assert.equal(next.parentId, old.id)
		assert.deepEqual(old, snapshot)
		assert.throws(() => extendTranscriptPrefix(next, header, history), TranscriptIntegrityError)
	})

	it("seals exact structured content including signatures, arguments, and image bytes", () => {
		const messages = [{ role: "assistant", content: [
			{ type: "thinking", signature: "sig", thinking: "thought" },
			{ type: "tool_use", id: "call", input: { path: "file" } },
			{ type: "image", source: { data: "original" } },
		] }]
		const prefix = extendTranscriptPrefix(undefined, header, messages)
		for (const word of ["sig", "file", "original"]) {
			const edited = JSON.parse(JSON.stringify(messages).replace(`\"${word}\"`, '"changed"'))
			assert.throws(() => extendTranscriptPrefix(prefix, header, edited), TranscriptIntegrityError)
		}
	})
})
