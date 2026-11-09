import type { Anthropic } from "@anthropic-ai/sdk"
import { expect } from "chai"
import { describe, it } from "mocha"
import { AnthropicThinkingRecovery } from "../anthropic-thinking-recovery"

const thought = (signature: string): Anthropic.ContentBlockParam => ({ type: "thinking", thinking: `thought ${signature}`, signature })
const redacted = (data: string): Anthropic.ContentBlockParam => ({ type: "redacted_thinking", data })
const text = (value: string): Anthropic.ContentBlockParam => ({ type: "text", text: value })
const mismatch = (messageIndex: number, blockIndex: number) => new Error(
	`messages.${messageIndex}.content.${blockIndex}: Invalid \`signature\` in \`thinking\` block. The block is bound to a different conversation. Remove the block, or set \`thinking.block_binding.prefix_mismatch_behavior\` to "drop_block".`,
)

function history(): Anthropic.MessageParam[] {
	return [
		{ role: "user", content: "question" },
		{ role: "assistant", content: [thought("valid"), text("kept answer")] },
		{ role: "user", content: "follow up" },
		{ role: "assistant", content: [thought("rejected"), text("read a file"), { type: "tool_use", id: "tool_1", name: "read_file", input: { path: "README.md" } }, redacted("opaque")] },
		{ role: "user", content: [{ type: "tool_result", tool_use_id: "tool_1", content: "file contents" }] },
		{ role: "assistant", content: [thought("later"), text("finished")] },
	]
}

describe("AnthropicThinkingRecovery", () => {
	it("preserves valid append-only thinking and all outgoing blocks before a rejection", () => {
		const messages = history()
		const prepared = new AnthropicThinkingRecovery().prepareAnthropicMessages(messages)
		expect(prepared).to.deep.equal(messages)
		for (let index = 0; index < messages.length; index++) expect(prepared[index]).to.equal(messages[index])
	})

	it("strips the named thought and every later thought/redacted block without touching text or tools", () => {
		const messages = history()
		const original = JSON.stringify(messages)
		for (const message of messages) {
			if (Array.isArray(message.content)) {
				message.content.forEach(Object.freeze)
				Object.freeze(message.content)
			}
			Object.freeze(message)
		}
		Object.freeze(messages)

		const repaired = new AnthropicThinkingRecovery().recoverAnthropicMessages(mismatch(3, 0), messages)
		expect(repaired).to.deep.equal([
			messages[0], messages[1], messages[2],
			{ role: "assistant", content: [text("read a file"), { type: "tool_use", id: "tool_1", name: "read_file", input: { path: "README.md" } }] },
			messages[4], { role: "assistant", content: [text("finished")] },
		])
		expect(repaired[1]).to.equal(messages[1])
		expect(repaired[4]).to.equal(messages[4])
		expect(JSON.stringify(messages)).to.equal(original)
	})

	it("retains earlier thoughts within the rejected message and accepts SDK error envelopes", () => {
		const messages: Anthropic.MessageParam[] = [{ role: "assistant", content: [thought("first"), text("answer"), redacted("bad"), thought("tail")] }]
		const sdkError = new Error(`400 ${JSON.stringify({ error: { type: "invalid_request_error", message: mismatch(0, 2).message } })}`)
		const repaired = new AnthropicThinkingRecovery().recoverAnthropicMessages(sdkError, messages)
		expect(repaired).to.deep.equal([{ role: "assistant", content: [thought("first"), text("answer")] }])
	})

	it("remembers the whole rejected suffix but preserves new thinking produced after repair", () => {
		const recovery = new AnthropicThinkingRecovery()
		const messages = history()
		recovery.recoverAnthropicMessages(mismatch(3, 0), messages)
		const appended: Anthropic.MessageParam[] = [...messages, { role: "user", content: "new question" }, { role: "assistant", content: [thought("fresh"), redacted("fresh-opaque"), text("new answer")] }]
		const prepared = recovery.prepareAnthropicMessages(appended)
		expect(prepared[5]).to.deep.equal({ role: "assistant", content: [text("finished")] })
		expect(prepared[7]).to.equal(appended[7])
		expect(JSON.stringify(prepared)).not.to.include('"signature":"rejected"')
		expect(JSON.stringify(prepared)).not.to.include('"signature":"later"')
		expect(JSON.stringify(prepared)).not.to.include('"data":"opaque"')
	})

	it("does not send empty messages when rejected turns contained only thinking", () => {
		const recovery = new AnthropicThinkingRecovery()
		const messages: Anthropic.MessageParam[] = [
			{ role: "user", content: "question" },
			{ role: "assistant", content: [thought("only"), redacted("only-opaque")] },
			{ role: "user", content: "next question" },
			{ role: "assistant", content: [thought("later-only")] },
		]
		expect(recovery.recoverAnthropicMessages(mismatch(1, 0), messages)).to.deep.equal([messages[0], messages[2]])
		expect(recovery.prepareAnthropicMessages(messages)).to.deep.equal([messages[0], messages[2]])
	})

	it("interprets subsequent rejection indices against the filtered outgoing request", () => {
		const recovery = new AnthropicThinkingRecovery()
		const messages: Anthropic.MessageParam[] = [{ role: "user", content: "question" }, { role: "assistant", content: [thought("old")] }]
		recovery.recoverAnthropicMessages(mismatch(1, 0), messages)
		const appended: Anthropic.MessageParam[] = [...messages, { role: "user", content: "new question" }, { role: "assistant", content: [thought("new"), redacted("new-opaque"), text("answer")] }]
		const outgoing = recovery.prepareAnthropicMessages(appended)
		expect(recovery.recoverAnthropicMessages(mismatch(2, 0), outgoing)).to.deep.equal([
			messages[0], appended[2], { role: "assistant", content: [text("answer")] },
		])
		expect(recovery.prepareAnthropicMessages(appended)).to.deep.equal([
			messages[0], appended[2], { role: "assistant", content: [text("answer")] },
		])
	})

	it("keeps signature and redacted-data identities separate and isolates handlers", () => {
		const recovery = new AnthropicThinkingRecovery()
		recovery.recoverAnthropicMessages(mismatch(0, 0), [{ role: "assistant", content: [thought("same")] }])
		const messages: Anthropic.MessageParam[] = [{ role: "assistant", content: [redacted("same"), text("answer")] }]
		expect(recovery.prepareAnthropicMessages(messages)).to.deep.equal(messages)
		const independent = new AnthropicThinkingRecovery()
		const original: Anthropic.MessageParam[] = [{ role: "assistant", content: [thought("same")] }]
		expect(independent.prepareAnthropicMessages(original)).to.deep.equal(original)
	})

	for (const error of [
		new Error("400 invalid_request_error"),
		new Error("messages.3.content.0: Invalid `signature` in `thinking` block."),
		new Error("messages.3.content.0: Invalid `signature` in `thinking` block. The signature cannot be decrypted."),
		new Error("messages.3.content.0: Invalid `signature` in `thinking` block. The block is bound to a different account."),
		new Error("messages.3.content.0: Invalid `signature` in `thinking` block. The block is bound to a different conversation"),
		new Error("messages.-1.content.0: Invalid `signature` in `thinking` block. The block is bound to a different conversation."),
		new Error("network failure"),
		{ message: mismatch(3, 0).message },
	]) {
		it(`propagates unrecognized errors unchanged: ${error.message}`, () => {
			const recovery = new AnthropicThinkingRecovery()
			const messages = history()
			let caught: unknown
			try {
				recovery.recoverAnthropicMessages(error, messages)
			} catch (failure) {
				caught = failure
			}
			expect(caught).to.equal(error)
			expect(recovery.prepareAnthropicMessages(messages)).to.deep.equal(messages)
		})
	}

	for (const [messageIndex, blockIndex] of [[99, 0], [3, 99], [0, 0], [3, 1], [3, 2]]) {
		it(`propagates exact errors naming an absent/non-thinking block at ${messageIndex}.${blockIndex}`, () => {
			const recovery = new AnthropicThinkingRecovery()
			const error = mismatch(messageIndex!, blockIndex!)
			const messages = history()
			expect(() => recovery.recoverAnthropicMessages(error, messages)).to.throw(error)
			expect(recovery.prepareAnthropicMessages(messages)).to.deep.equal(messages)
		})
	}
})
