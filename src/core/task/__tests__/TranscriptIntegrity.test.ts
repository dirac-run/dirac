import { strict as assert } from "node:assert"
import { describe, it } from "mocha"
import type { ApiConversationProviderState } from "@core/api/conversation"
import { TranscriptIntegrityError } from "@core/api/TranscriptPrefix"
import type { DiracStorageMessage } from "@shared/messages/content"
import { ApiConversationManager } from "../ApiConversationManager"
import { TaskState } from "../TaskState"

function fixture(initialState: ApiConversationProviderState = {}) {
	let state = structuredClone(initialState)
	const history: DiracStorageMessage[] = [{ role: "user", content: "question" }]
	const taskState = new TaskState()
	const dependencies: any = {
		taskState,
		getRequestRuntime: () => undefined,
		api: { supportsNativeWebSearch: () => true },
		contextManager: { getTruncatedMessages: (messages: DiracStorageMessage[]) => messages.slice(-1) },
		messageStateHandler: {
			getApiConversationHistory: () => structuredClone(history),
			getApiConversationProviderState: () => structuredClone(state),
			overwriteApiConversationProviderState: async (value: ApiConversationProviderState) => { state = structuredClone(value) },
			addToApiConversationHistory: async (message: DiracStorageMessage) => { history.push(structuredClone(message)) },
			appendToLastApiConversationUserMessage: async (block: any) => {
				const message = history.at(-1)!
				message.content = typeof message.content === "string" ? [{ type: "text", text: message.content }, block] : [...message.content, block]
			},
			saveDiracMessagesAndUpdateHistory: async () => { },
		},
	}
	const manager = new ApiConversationManager(dependencies)
	const dispatch = (systemPrompt = "fixed", tools: any[] = []) => manager.prepareProviderConversationDispatch({
		systemPrompt, tools, truncatedMessages: structuredClone(history), providerId: "openai-codex", modelId: "gpt-6-astra",
	})
	return { manager, dependencies, taskState, history, dispatch, state: () => structuredClone(state) }
}


describe("transcript integrity at dispatch", () => {
	it("uses current instructions and appends supervision without duplicate updates", async () => {
		const f = fixture()
		assert.equal(await f.manager.prepareTranscriptInstructions("fixed", "child running"), "fixed")
		await f.dispatch()
		const first = structuredClone(f.history)
		assert.equal(await f.manager.prepareTranscriptInstructions("changed rule", "child complete"), "changed rule")
		assert.deepEqual(f.history.slice(0, first.length), first)
		assert.doesNotMatch(JSON.stringify(f.history.at(-1)), /changed rule/)
		assert.match(JSON.stringify(f.history.at(-1)), /child complete/)
		await f.dispatch("changed rule")
		const length = f.history.length
		await f.manager.prepareTranscriptInstructions("changed rule", "child complete")
		assert.equal(f.history.length, length)
	})

	it("forks tools and hosted search generations without paid condensation, but rejects historical edits", async () => {
		const f = fixture()
		await f.dispatch()
		const original = f.state().transcript!
		let compactions = 0
		f.dependencies.api.compactConversation = async () => { compactions++; return { input: [] } }
		const toolsChanged = await f.dispatch("fixed", [{ name: "added" }])
		assert.equal(f.state().transcript!.parentId, original.id)
		assert.equal(toolsChanged.options.breakProviderContinuation, true)
		const next = f.state().transcript!
		f.taskState.activeSkillIds = ["web-search"]
		const searchChanged = await f.dispatch()
		assert.equal(searchChanged.options.enableNativeWebSearch, true)
		assert.equal(f.state().transcript!.parentId, next.id)
		assert.equal(compactions, 0)
		const baseline = f.state().transcript
		f.history[0].content = "rewritten"
		await assert.rejects(f.dispatch("another header"), TranscriptIntegrityError)
		assert.deepEqual(f.state().transcript, baseline)
	})

	it("starts a linked generation on model/provider changes", async () => {
		const f = fixture()
		await f.dispatch()
		const previous = f.state().transcript!
		const changed = await f.manager.prepareProviderConversationDispatch({
			systemPrompt: "act", tools: [], truncatedMessages: f.history, providerId: "anthropic", modelId: "act-model",
		})
		assert.equal(f.state().transcript!.parentId, previous.id)
		assert.equal(changed.options.breakProviderContinuation, true)
		assert.equal(changed.options.checkpoint, undefined)
	})

	it("breaks continuation on checkpoint branches even with retained assistant response IDs", async () => {
		const f = fixture({ historyBranchId: "branch", previousTranscriptId: "parent" })
		f.history.push({ role: "assistant", content: "old", id: "response-old", modelInfo: { providerId: "openai-codex", modelId: "gpt-6-astra", mode: "act" } })
		const dispatch = await f.dispatch()
		assert.equal(dispatch.options.breakProviderContinuation, true)
		assert.equal(f.state().transcript!.parentId, "parent")
	})

	it("retains current runtime context when truncation is scheduled after instructions", async () => {
		const f = fixture()
		await f.manager.prepareTranscriptInstructions("current instructions", "current runtime")
		await f.dispatch("current instructions")
		f.history.push({ role: "user", content: "retained summary" })
		await f.manager.prepareTranscriptInstructions("current instructions", "current runtime")
		await f.manager.scheduleProviderConversationCompaction(undefined, [0, 0])
		// The builder may already have applied the range and captured a stale projection.
		f.taskState.conversationHistoryDeletedRange = [0, 0]
		const dispatch = await f.dispatch("current instructions")
		assert.match(JSON.stringify(dispatch.messages), /current runtime/)
		assert.equal(f.state().transcriptInstructions?.systemPrompt, "current instructions")
	})

	it("rejects archived edits before calling the compactor", async () => {
		const f = fixture()
		await f.dispatch()
		let calls = 0
		f.dependencies.api.compactConversation = async () => { calls++; return { input: [] } }
		await f.manager.scheduleProviderConversationCompaction(undefined, [0, 0])
		f.history[0].content = "rewritten before condense"
		await assert.rejects(f.dispatch(), TranscriptIntegrityError)
		assert.equal(calls, 0)
	})

	it("starts a new append-only transcript for plaintext condensation", async () => {
		const f = fixture()
		await f.dispatch()
		const old = f.state().transcript!
		f.history.push({ role: "user", content: "summary" })
		await f.manager.scheduleProviderConversationCompaction(undefined, [0, 0])
		const condensed = await f.dispatch()
		assert.equal(f.state().transcript!.parentId, old.id)
		assert.deepEqual(condensed.messages, [{ role: "user", content: "summary" }])
		// Subsequent requests keep exactly the same condensed prefix.
		const next = await f.manager.prepareProviderConversationDispatch({
			systemPrompt: "fixed", tools: [], truncatedMessages: condensed.messages,
			providerId: "openai-codex", modelId: "gpt-6-astra",
		})
		assert.deepEqual(next.messages, condensed.messages)
	})

	it("restores the guard on reopen rather than accepting a new baseline", async () => {
		const f = fixture()
		await f.dispatch()
		const reopened = fixture(f.state())
		await reopened.dispatch()
		reopened.history[0].content = "changed after restart"
		await assert.rejects(reopened.dispatch(), TranscriptIntegrityError)
	})

	it("condensation starts a new transcript but never permits editing archived history", async () => {
		const f = fixture()
		await f.dispatch()
		const original = f.state().transcript!
		f.history.push({ role: "user", content: "summary" })
		f.dependencies.api.compactConversation = async () => ({ input: [{ type: "compaction", encrypted_content: "opaque" }] })
		await f.manager.scheduleProviderConversationCompaction(undefined, [0, 0])
		await f.dispatch()
		assert.notEqual(f.state().transcript!.id, original.id)
		assert.equal(f.state().transcript!.parentId, original.id)
		assert.deepEqual(f.history[0], { role: "user", content: "question" })
		f.history[0].content = "archived edit"
		await assert.rejects(f.dispatch(), TranscriptIntegrityError)
	})

})
