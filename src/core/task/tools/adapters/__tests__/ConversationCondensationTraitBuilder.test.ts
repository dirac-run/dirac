import { strict as assert } from "node:assert"
import type { ApiStream, ApiStreamChunk } from "@core/api/transform/stream"
import type { UtilityModelRequest } from "@core/utility-model/UtilityModelRunner"
import * as utilityModel from "@core/utility-model/UtilityModelRunner"
import type { ModelProviderSelection } from "@shared/api"
import type { DiracStorageMessage } from "@shared/messages/content"
import { afterEach, describe, it } from "mocha"
import sinon from "sinon"
import { createMockTaskConfig } from "../../__tests__/helpers/mockTaskConfig"
import { SurfaceAdapter } from "../SurfaceAdapter"
import {
	buildConversationCondensationTrait,
	ConversationCondensationUnavailableError,
} from "../traits/ConversationCondensationTraitBuilder"

const selection: ModelProviderSelection = {
	provider: "openai",
	modelId: "utility-model",
}

function textStream(text: string, onComplete?: () => void): ApiStream {
	return (async function* (): AsyncGenerator<ApiStreamChunk> {
		yield { type: "text", text }
		onComplete?.()
	})()
}

function createEnvironment(history: DiracStorageMessage[] = [{ role: "user", content: "current task request" }]) {
	const { config } = createMockTaskConfig()
	const settings: Record<string, unknown> = {
		utilityModelEnabled: true,
		utilityModelUseCondense: true,
		utilityModelUseNewTask: true,
		utilityModelSelection: selection,
	}
	const getApiConfiguration = sinon.stub().returns({
		actModeApiProvider: "openai",
		actModeApiModelId: "active-model",
		openAiApiKey: "active-key",
	})

	Object.defineProperties(config, {
		utilityModelEnabled: { get: () => settings.utilityModelEnabled, configurable: true },
		utilityModelUseCondense: { get: () => settings.utilityModelUseCondense ?? true, configurable: true },
		utilityModelUseNewTask: { get: () => settings.utilityModelUseNewTask ?? true, configurable: true },
		utilityModelSelection: { get: () => settings.utilityModelSelection, configurable: true },
	})
	config.callbacks.createUtilityModelRunner = (runnerSelection, options) =>
		utilityModel.createUtilityModelRunner(getApiConfiguration(), runnerSelection, options)
	config.services.contextManager = {
		getTruncatedMessages: (messages: DiracStorageMessage[]) => messages,
	} as any
	config.messageState.getApiConversationHistory = sinon.stub().returns(history)

	return { config, settings, getApiConfiguration }
}

afterEach(() => sinon.restore())

describe("ConversationCondensationTraitBuilder", () => {
	it("is unavailable when the utility model feature is disabled", async () => {
		const { config, settings } = createEnvironment()
		settings.utilityModelEnabled = false
		settings.utilityModelUseCondense = false
		const trait = buildConversationCondensationTrait(config)

		assert.equal(trait.isAvailable("conversation_continuation"), false)
		await assert.rejects(
			() => trait.condenseConversation("conversation_continuation", { historyScope: "effective" }),
			ConversationCondensationUnavailableError,
		)
	})

	it("is unavailable when the utility model selection is missing", () => {
		const { config, settings } = createEnvironment()
		settings.utilityModelSelection = undefined
		const trait = buildConversationCondensationTrait(config)

		assert.equal(trait.isAvailable("conversation_continuation"), false)
	})

	it("is unavailable when the requested template is not registered", () => {
		const { config } = createEnvironment()
		const trait = buildConversationCondensationTrait(config)

		assert.equal(trait.isAvailable("unregistered-template"), false)
	})

	it("is available only when settings and a registered template are present without constructing a utility runner", () => {
		const { config } = createEnvironment()
		const createRunner = sinon.stub(utilityModel, "createUtilityModelRunner")
		const trait = buildConversationCondensationTrait(config)

		assert.equal(trait.isAvailable("conversation_continuation"), true)
		sinon.assert.notCalled(createRunner)
	})

	it("uses the request-bound settings for each call without rebuilding or replacing the active task API", async () => {
		const { config, settings, getApiConfiguration } = createEnvironment()
		const requests: UtilityModelRequest[] = []
		const updatedSelection: ModelProviderSelection = { provider: "openai", modelId: "updated-utility-model" }
		const createRunner = sinon
			.stub(utilityModel, "createUtilityModelRunner")
			.callsFake((_configuration, runnerSelection, options) => {
				return {
					run(request: UtilityModelRequest) {
						requests.push(request)
						return textStream("complete condensation", () => {
							options?.onModelResolved?.({ selection: runnerSelection, modelId: "resolved-utility-model" })
						})
					},
				} as ReturnType<typeof utilityModel.createUtilityModelRunner>
			})
		const trait = buildConversationCondensationTrait(config)

		settings.utilityModelEnabled = false
		settings.utilityModelUseCondense = false
		assert.equal(trait.isAvailable("conversation_continuation"), false)
		settings.utilityModelEnabled = true
		settings.utilityModelUseCondense = true
		settings.utilityModelSelection = updatedSelection
		assert.equal(trait.isAvailable("conversation_continuation"), true)
		sinon.assert.notCalled(createRunner)

		assert.deepEqual(await trait.condenseConversation("conversation_continuation", { historyScope: "effective" }), {
			text: "complete condensation",
			modelIdentity: { providerId: "openai", modelId: "resolved-utility-model" },
		})
		assert.equal(requests.length, 1)
		sinon.assert.calledOnce(createRunner)
		assert.equal(createRunner.firstCall.args[0], getApiConfiguration.returnValues[0])
		assert.equal(createRunner.firstCall.args[1], updatedSelection)
		assert.equal(createRunner.firstCall.args[2]?.ulid, config.ulid)
		assert.equal(typeof createRunner.firstCall.args[2]?.onModelResolved, "function")
	})

	it("serializes history from the current task only", async () => {
		const history: DiracStorageMessage[] = [{ role: "user", content: "current task-only history" }]
		const { config } = createEnvironment(history)
		const requests: UtilityModelRequest[] = []
		sinon.stub(utilityModel, "createUtilityModelRunner").callsFake((_configuration, runnerSelection, options) => {
			return {
				run(request: UtilityModelRequest) {
					requests.push(request)
					return textStream("complete condensation", () => {
						options?.onModelResolved?.({ selection: runnerSelection, modelId: runnerSelection.modelId })
					})
				},
			} as ReturnType<typeof utilityModel.createUtilityModelRunner>
		})
		const trait = buildConversationCondensationTrait(config)

		await trait.condenseConversation("conversation_continuation", { historyScope: "effective" })

		assert.equal(config.messageState.getApiConversationHistory.callCount, 1)
		assert.match(requests[0].messages[0].content as string, /current task-only history/)
		assert.deepEqual(history, [{ role: "user", content: "current task-only history" }])
	})

	it("sends complete history and trailing intent to the Utility model after repeated compactions", async () => {
		const history: DiracStorageMessage[] = [
			{ role: "user", content: "full-history-first" },
			{ role: "assistant", content: "full-history-before-compaction" },
			{ role: "user", content: "full-history-first-summary" },
			{ role: "assistant", content: "full-history-between-compactions" },
			{ role: "user", content: "full-history-second-summary" },
			{ role: "assistant", content: "full-history-last" },
		]
		const { config } = createEnvironment(history)
		config.taskState.conversationHistoryDeletedRange = [1, 4]
		const getTruncatedMessages = sinon.stub().returns([history[0], history.at(-1)])
		config.services.contextManager = { getTruncatedMessages } as any
		const requests: UtilityModelRequest[] = []
		sinon.stub(utilityModel, "createUtilityModelRunner").callsFake((_configuration, runnerSelection, options) => {
			return {
				run(request: UtilityModelRequest) {
					requests.push(request)
					return textStream("complete handoff", () => {
						options?.onModelResolved?.({ selection: runnerSelection, modelId: runnerSelection.modelId })
					})
				},
			} as ReturnType<typeof utilityModel.createUtilityModelRunner>
		})
		const trait = buildConversationCondensationTrait(config)

		await trait.condenseConversation("task_handoff", {
			historyScope: "complete",
			additionalSourceText: '=== REQUESTED NEW TASK INTENT ===\n{"intent":"authoritative intent"}',
		})

		assert.equal(requests.length, 1)
		const source = JSON.parse(requests[0].messages[0].content as string).sourceText as string
		for (const marker of [
			"full-history-first",
			"full-history-before-compaction",
			"full-history-first-summary",
			"full-history-between-compactions",
			"full-history-second-summary",
			"full-history-last",
		]) {
			assert.ok(source.includes(marker), `Missing Utility request marker: ${marker}`)
		}
		assert.ok(source.indexOf("REQUESTED NEW TASK INTENT") > source.indexOf("full-history-last"))
		assert.ok(source.includes("authoritative intent"))
		sinon.assert.notCalled(getTruncatedMessages)
	})

	it("exposes original current-turn requests through orchestration independently of effective API history", () => {
		const { config } = createEnvironment([{ role: "user", content: "old API context" }])
		config.messageState.getDiracMessages.returns([
			{ content: { type: "markdown", role: "user", content: "Task A" } },
			{ content: { type: "card", card: { kind: "task_completion", status: "success" } } },
			{ content: { type: "markdown", role: "user", content: "Task B" } },
			{ content: { type: "markdown", role: "user", content: "Clarification for B" } },
		])
		const environment = new SurfaceAdapter(config)

		assert.deepEqual(environment.orchestration.getCurrentTurnUserRequests(), ["Task B", "Clarification for B"])
		sinon.assert.notCalled(config.messageState.getApiConversationHistory)
	})

	it("exposes a narrow facade for parent tasks and no capability for subagents", () => {
		const { config } = createEnvironment()
		config.isSubagentExecution = false
		const parentEnvironment = new SurfaceAdapter(config)

		assert.ok(parentEnvironment.conversationCondensation)
		assert.equal("api" in parentEnvironment.conversationCondensation!, false)
		assert.equal("createHandler" in parentEnvironment.conversationCondensation!, false)

		config.isSubagentExecution = true
		const subagentEnvironment = new SurfaceAdapter(config)
		assert.equal(subagentEnvironment.conversationCondensation, undefined)
	})
})
