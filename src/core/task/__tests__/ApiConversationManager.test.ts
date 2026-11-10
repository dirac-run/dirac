import { strict as assert } from "node:assert"
import { HookFactory } from "@core/hooks/hook-factory"
import { HookCleanupError } from "@core/hooks/HookCleanupError"
import { describe, it } from "mocha"
import sinon from "sinon"
import { ApiConversationManager } from "../ApiConversationManager"
import { TaskState } from "../TaskState"
import { expectLoggerErrors } from "../../../test/loggerGuard"
import { NATIVE_WEB_SEARCH_SKILL_NAME } from "@shared/skills"

describe("ApiConversationManager steering delivery", () => {
	it("does not consume steering before the provider dispatch boundary", async () => {
		const claimSteeringMessages = sinon.stub()
		const dependencies: any = {
			taskState: new TaskState(),
			stateManager: { getGlobalSettingsKey: sinon.stub() },
			runUserPromptSubmitHook: sinon.stub().resolves({}),
			loadContext: sinon.stub().callsFake(async (content: any[]) => [content, "", false, [], false, undefined]),
			claimSteeringMessages,
			taskMessenger: { upsertApiStatus: sinon.stub().resolves(), createCard: sinon.stub() },
			messageStateHandler: {
				addToApiConversationHistory: sinon.stub().resolves(),
				findMessageIndexById: sinon.stub().returns(0),
				patchApiStatusById: sinon.stub().resolves(),
			},
			postStateToWebview: sinon.stub().resolves(),
			onContextCompacted: sinon.stub(),
			taskInitializationStartTime: performance.now(),
			ulid: "task-ulid",
			taskId: "task-id",
		}
		const manager = new ApiConversationManager(dependencies)

		const result = await manager.prepareApiRequest({
			userContent: [],
			includeFileDetails: false,
			useCompactPrompt: false,
			previousApiReqIndex: 0,
			isFirstRequest: false,
			providerId: "provider",
			modelId: "model",
			mode: "act",
			requestId: "request-1",
		})

		assert.equal(claimSteeringMessages.callCount, 0)
		assert.equal(
			result.userContent.some((block: any) => block.text?.includes("<steering_messages>")),
			false,
		)
		assert.equal(result.didConsumeUserContent, true)
	})

	it("consumes a matching mode-entry marker after preparing a normal request", async () => {
		for (const mode of ["plan", "act"] as const) {
			const taskState = new TaskState()
			taskState.pendingModeNotice = { mode, includedInRequestId: "request-1" }
			const manager = new ApiConversationManager({
				taskState,
				stateManager: { getGlobalSettingsKey: sinon.stub() },
				runUserPromptSubmitHook: sinon.stub().resolves({}),
				loadContext: sinon.stub().callsFake(async (content: any[]) => [content, "", false, [], false, undefined]),
				taskMessenger: { upsertApiStatus: sinon.stub().resolves(), createCard: sinon.stub() },
				messageStateHandler: {
					addToApiConversationHistory: sinon.stub().resolves(),
					findMessageIndexById: sinon.stub().returns(0),
					patchApiStatusById: sinon.stub().resolves(),
				},
				postStateToWebview: sinon.stub().resolves(),
				taskInitializationStartTime: performance.now(),
				ulid: "task-ulid",
				taskId: "task-id",
			} as any)

			await manager.prepareApiRequest({
				userContent: [],
				includeFileDetails: false,
				useCompactPrompt: false,
				previousApiReqIndex: 0,
				isFirstRequest: false,
				providerId: "provider",
				modelId: "model",
				mode,
				requestId: "request-1",
			})

			assert.equal(taskState.pendingModeNotice, undefined)
		}
	})

	it("does not consume a newer mode-entry marker from a stale request", async () => {
		const taskState = new TaskState()
		taskState.pendingModeNotice = { mode: "act" }
		const manager = new ApiConversationManager({
			taskState,
			stateManager: { getGlobalSettingsKey: sinon.stub() },
			runUserPromptSubmitHook: sinon.stub().resolves({}),
			loadContext: sinon.stub().callsFake(async (content: any[]) => [content, "", false, [], false, undefined]),
			taskMessenger: { upsertApiStatus: sinon.stub().resolves(), createCard: sinon.stub() },
			messageStateHandler: {
				addToApiConversationHistory: sinon.stub().resolves(),
				findMessageIndexById: sinon.stub().returns(0),
				patchApiStatusById: sinon.stub().resolves(),
			},
			postStateToWebview: sinon.stub().resolves(),
			taskInitializationStartTime: performance.now(),
			ulid: "task-ulid",
			taskId: "task-id",
		} as any)

		await manager.prepareApiRequest({
			userContent: [],
			includeFileDetails: false,
			useCompactPrompt: false,
			previousApiReqIndex: 0,
			isFirstRequest: false,
			providerId: "provider",
			modelId: "model",
			mode: "plan",
			requestId: "request-1",
		})

		assert.equal(taskState.pendingModeNotice?.mode, "act")
	})

	it("does not consume a newer same-mode notice after a round-trip transition", async () => {
		const taskState = new TaskState()
		taskState.pendingModeNotice = { mode: "act", includedInRequestId: "request-1" }
		const manager = new ApiConversationManager({
			taskState,
			stateManager: { getGlobalSettingsKey: sinon.stub() },
			runUserPromptSubmitHook: sinon.stub().resolves({}),
			loadContext: sinon.stub().callsFake(async (content: any[]) => [content, "", false, [], false, undefined]),
			taskMessenger: { upsertApiStatus: sinon.stub().resolves(), createCard: sinon.stub() },
			messageStateHandler: {
				addToApiConversationHistory: sinon.stub().callsFake(async () => {
					taskState.pendingModeNotice = { mode: "act", includedInRequestId: "request-2" }
				}),
				findMessageIndexById: sinon.stub().returns(0),
				patchApiStatusById: sinon.stub().resolves(),
			},
			postStateToWebview: sinon.stub().resolves(),
			taskInitializationStartTime: performance.now(),
			ulid: "task-ulid",
			taskId: "task-id",
		} as any)

		await manager.prepareApiRequest({
			userContent: [],
			includeFileDetails: false,
			useCompactPrompt: false,
			previousApiReqIndex: 0,
			isFirstRequest: false,
			providerId: "provider",
			modelId: "model",
			mode: "act",
			requestId: "request-1",
		})

		assert.deepEqual(taskState.pendingModeNotice, { mode: "act", includedInRequestId: "request-2" })
	})

	it("retains the mode-entry marker when request preparation fails before persistence", async () => {
		const taskState = new TaskState()
		taskState.pendingModeNotice = { mode: "act", includedInRequestId: "request-1" }
		const manager = new ApiConversationManager({
			taskState,
			stateManager: { getGlobalSettingsKey: sinon.stub() },
			runUserPromptSubmitHook: sinon.stub().resolves({}),
			loadContext: sinon.stub().callsFake(async (content: any[]) => [content, "", false, [], false, undefined]),
			taskMessenger: { upsertApiStatus: sinon.stub().resolves(), createCard: sinon.stub() },
			messageStateHandler: {
				addToApiConversationHistory: sinon.stub().rejects(new Error("history persistence failed")),
				findMessageIndexById: sinon.stub().returns(0),
				patchApiStatusById: sinon.stub().resolves(),
			},
			postStateToWebview: sinon.stub().resolves(),
			taskInitializationStartTime: performance.now(),
			ulid: "task-ulid",
			taskId: "task-id",
		} as any)

		await assert.rejects(
			manager.prepareApiRequest({
				userContent: [],
				includeFileDetails: false,
				useCompactPrompt: false,
				previousApiReqIndex: 0,
				isFirstRequest: false,
				providerId: "provider",
				modelId: "model",
				mode: "act",
				requestId: "request-1",
			}),
			/history persistence failed/,
		)

		assert.equal(taskState.pendingModeNotice?.mode, "act")
	})

	it("runs the persistence callback immediately after the user message is stored", async () => {
		const events: string[] = []
		const dependencies: any = {
			taskState: new TaskState(),
			stateManager: { getGlobalSettingsKey: sinon.stub() },
			runUserPromptSubmitHook: sinon.stub().resolves({}),
			loadContext: sinon.stub().callsFake(async (content: any[]) => [content, "", false, [], false, undefined]),
			taskMessenger: { upsertApiStatus: sinon.stub().resolves(), createCard: sinon.stub() },
			messageStateHandler: {
				addToApiConversationHistory: sinon.stub().callsFake(async () => events.push("persisted")),
				findMessageIndexById: sinon.stub().returns(0),
				patchApiStatusById: sinon.stub().resolves(),
			},
			postStateToWebview: sinon.stub().resolves(),
			taskInitializationStartTime: performance.now(),
			ulid: "task-ulid",
			taskId: "task-id",
		}
		const manager = new ApiConversationManager(dependencies)

		await manager.prepareApiRequest({
			userContent: [],
			includeFileDetails: false,
			useCompactPrompt: false,
			previousApiReqIndex: 0,
			isFirstRequest: false,
			providerId: "provider",
			modelId: "model",
			mode: "act",
			requestId: "request-1",
			afterUserContentPersisted: async () => {
				events.push("callback")
			},
		})

		assert.deepEqual(events, ["persisted", "callback"])
	})

	it("prepares active-model automatic compaction when Utility condensation is unavailable", async () => {
		const taskState = new TaskState()
		taskState.pendingModeNotice = { mode: "act" }
		const loadContext = sinon.stub()
		const createCard = sinon.stub()
		const addToApiConversationHistory = sinon.stub().resolves()
		const onContextCompacted = sinon.stub()
		const manager = new ApiConversationManager({
			taskState,
			stateManager: { getGlobalSettingsKey: sinon.stub() },
			runUserPromptSubmitHook: sinon.stub().resolves({}),
			loadContext,
			activateSkill: sinon.stub().resolves(),
			taskMessenger: { upsertApiStatus: sinon.stub().resolves(), createCard },
			messageStateHandler: {
				addToApiConversationHistory,
				findMessageIndexById: sinon.stub().returns(0),
				patchApiStatusById: sinon.stub().resolves(),
			},
			getPinnedContext: () => "retain this pinned context",
			postStateToWebview: sinon.stub().resolves(),
			onContextCompacted,
			taskInitializationStartTime: performance.now(),
			ulid: "task-ulid",
			taskId: "task-id",
		} as any)

		const result = await manager.prepareApiRequest({
			userContent: [{ type: "text", text: "continue the task" }],
			shouldCompact: true,
			includeFileDetails: false,
			useCompactPrompt: false,
			previousApiReqIndex: 7,
			isFirstRequest: false,
			providerId: "provider",
			modelId: "model",
			mode: "act",
			requestId: "request-1",
		})

		assert.equal(loadContext.callCount, 0)
		assert.equal(createCard.callCount, 0)
		assert.equal(taskState.lastAutoCondenseTriggerIndex, 7)
		assert.equal(taskState.pendingCondenseSource, "automatic")
		assert.equal(taskState.pendingModeNotice?.mode, "act")
		assert.equal(onContextCompacted.callCount, 0)
		assert.equal(result.didConsumeUserContent, true)
		const storedContent = addToApiConversationHistory.firstCall.args[0].content
		assert.ok(storedContent.some((block: any) => block.text === "retain this pinned context"))
		assert.ok(storedContent.some((block: any) => block.text?.includes("must now call the condense tool")))
	})

	it("does not consume user content when the prompt hook cancels", async () => {
		const taskState = new TaskState()
		taskState.pendingModeNotice = { mode: "plan" }
		const addToApiConversationHistory = sinon.stub().resolves()
		const manager = new ApiConversationManager({
			taskState,
			runUserPromptSubmitHook: sinon.stub().resolves({ cancel: true, errorMessage: "cancelled" }),
			messageStateHandler: { addToApiConversationHistory },
		} as any)

		const result = await manager.prepareApiRequest({
			userContent: [{ type: "text", text: "<steering_message>keep trying</steering_message>" }],
			includeFileDetails: false,
			useCompactPrompt: false,
			previousApiReqIndex: 4,
			isFirstRequest: false,
			providerId: "provider",
			modelId: "model",
			mode: "act",
			requestId: "request-1",
		})

		assert.equal(result.didConsumeUserContent, false)
		assert.equal(addToApiConversationHistory.callCount, 0)
		assert.equal(taskState.pendingModeNotice?.mode, "plan")
	})

	it("consumes direct-response commands without persisting ordinary user content", async () => {
		const taskState = new TaskState()
		taskState.pendingModeNotice = { mode: "act" }
		const addToApiConversationHistory = sinon.stub().resolves()
		const manager = new ApiConversationManager({
			taskState,
			runUserPromptSubmitHook: sinon.stub().resolves({}),
			loadContext: sinon.stub().resolves([[], "", false, [], true, "tools reloaded"]),
			messageStateHandler: { addToApiConversationHistory },
		} as any)

		const result = await manager.prepareApiRequest({
			userContent: [{ type: "text", text: "<steering_message>/reloadtools</steering_message>" }],
			includeFileDetails: false,
			useCompactPrompt: false,
			previousApiReqIndex: 4,
			isFirstRequest: false,
			providerId: "provider",
			modelId: "model",
			mode: "act",
			requestId: "request-1",
		})

		assert.equal(result.didConsumeUserContent, true)
		assert.equal(result.directResponseText, "tools reloaded")
		assert.equal(addToApiConversationHistory.callCount, 0)
		assert.equal(taskState.pendingModeNotice?.mode, "act")
	})

	it("consumes a condensation command even when local condensation cannot continue", async () => {
		const addToApiConversationHistory = sinon.stub().resolves()
		const runLocalConversationCompaction = sinon.stub().resolves(undefined)
		const manager = new ApiConversationManager({
			taskState: new TaskState(),
			runUserPromptSubmitHook: sinon.stub().resolves({}),
			loadContext: sinon.stub().resolves([[], "", false, [], false, undefined, [{ type: "condenseConversation" }]]),
			runLocalConversationCompaction,
			messageStateHandler: { addToApiConversationHistory },
		} as any)

		const result = await manager.prepareApiRequest({
			userContent: [{ type: "text", text: "<steering_message>/compact</steering_message>" }],
			includeFileDetails: false,
			useCompactPrompt: false,
			previousApiReqIndex: 4,
			isFirstRequest: false,
			providerId: "provider",
			modelId: "model",
			mode: "act",
			requestId: "request-1",
		})

		assert.equal(runLocalConversationCompaction.callCount, 1)
		assert.equal(result.didConsumeUserContent, true)
		assert.equal(addToApiConversationHistory.callCount, 0)
	})

	it("activates every unique slash-command skill before the first provider dispatch", async () => {
		const taskState = new TaskState()
		const history: any[] = []
		const events: string[] = []
		let providerState: any = {}
		const activateSkill = sinon.stub().callsFake(async (skillId: string) => {
			events.push(`activated:${skillId}`)
			taskState.activeSkillIds = [...new Set([...taskState.activeSkillIds, skillId])]
		})
		const dependencies: any = {
			taskState,
			api: { supportsNativeWebSearch: () => true },
			getRequestRuntime: () => undefined,
			contextManager: {
				getTruncatedMessages: sinon.stub().callsFake((messages: any[]) => messages),
			},
			stateManager: { getGlobalSettingsKey: sinon.stub() },
			runUserPromptSubmitHook: sinon.stub().resolves({}),
			loadContext: sinon.stub().resolves([
				[{ type: "text", text: "search current information" }],
				"",
				false,
				[],
				false,
				undefined,
				[
					{ type: "activateSkill", skillId: NATIVE_WEB_SEARCH_SKILL_NAME },
					{ type: "activateSkill", skillId: "code-review" },
					{ type: "activateSkill", skillId: NATIVE_WEB_SEARCH_SKILL_NAME },
				],
			]),
			activateSkill,
			taskMessenger: { upsertApiStatus: sinon.stub().resolves(), createCard: sinon.stub() },
			messageStateHandler: {
				addToApiConversationHistory: sinon.stub().callsFake(async (message: any) => {
					events.push("persisted")
					history.push(message)
				}),
				getApiConversationHistory: () => history,
				getApiConversationProviderState: () => providerState,
				overwriteApiConversationProviderState: sinon.stub().callsFake(async (state: any) => {
					providerState = state
				}),
				findMessageIndexById: sinon.stub().returns(0),
				patchApiStatusById: sinon.stub().resolves(),
			},
			postStateToWebview: sinon.stub().resolves(),
			taskInitializationStartTime: performance.now(),
			ulid: "task-ulid",
			taskId: "task-id",
		}
		const manager = new ApiConversationManager(dependencies)

		await manager.prepareApiRequest({
			userContent: [{ type: "text", text: "<task>/web-search search current information</task>" }],
			includeFileDetails: false,
			useCompactPrompt: false,
			previousApiReqIndex: 0,
			isFirstRequest: false,
			providerId: "openai-codex",
			modelId: "model",
			mode: "act",
			requestId: "request-1",
		})
		const dispatch = await manager.prepareProviderConversationDispatch({
			systemPrompt: "system",
			tools: [],
			truncatedMessages: history,
			providerId: "openai-codex",
			modelId: "model",
		})

		assert.deepEqual(events, [`activated:${NATIVE_WEB_SEARCH_SKILL_NAME}`, "activated:code-review", "persisted"])
		assert.equal(activateSkill.callCount, 2)
		assert.equal(dispatch.options.enableNativeWebSearch, true)
	})

	describe("provider-native conversation compaction", () => {
		function createCompactionDependencies() {
			const taskState = new TaskState()
			const history: any[] = [
				{ role: "user", content: "old question" },
				{
					role: "assistant",
					content: "condense call",
					id: "resp_old",
					modelInfo: { providerId: "openai-codex", modelId: "model" },
				},
				{ role: "user", content: "condense result" },
			]
			let providerState: any = {}
			const compactConversation = sinon.stub().resolves({ input: [{ type: "compaction", encrypted_content: "opaque" }] })
			const dependencies: any = {
				taskState,
				getRequestRuntime: () => undefined,
				getWorkingConfiguration: () => ({
					settings: Object.fromEntries(["hooksEnabled", "useAutoCondense", "autoCondenseContextLimits"].map((key) => [key, dependencies.stateManager.getGlobalSettingsKey(key)])),
					apiConfiguration: {},
				}),
				api: { compactConversation },
				contextManager: {
					getTruncatedMessages: sinon.stub().callsFake((messages: any[]) => messages),
					getNextTruncationRange: sinon.stub().returns([0, 1]),
					shouldCompactContextWindow: sinon.stub().returns(false),
				},
				messageStateHandler: {
					getApiConversationHistory: () => history,
					getApiConversationProviderState: () => providerState,
					overwriteApiConversationProviderState: sinon.stub().callsFake(async (state: any) => {
						providerState = state
					}),
					getDiracMessages: sinon.stub().returns([]),
					saveDiracMessagesAndUpdateHistory: sinon.stub().resolves(),
				},
				stateManager: {
					getGlobalSettingsKey: sinon.stub().callsFake((key: string) => (key === "hooksEnabled" ? false : undefined)),
				},
				getCurrentProviderInfo: () => ({ providerId: "openai-codex" }),
			}
			return { dependencies, history, compactConversation, getProviderState: () => providerState }
		}

		for (const fatal of [false, true]) {
			it(`${fatal ? "propagates fatal cleanup" : "fails open for ordinary errors"} through emergency truncation's real PreCompact caller`, async () => {
				if (!fatal) expectLoggerErrors()
				const { dependencies } = createCompactionDependencies()
				Object.assign(dependencies, {
					taskId: "task", ulid: "ulid",
					taskMessenger: { createCard: sinon.stub().resolves({ id: "hook" }) },
					setActiveHookExecution: sinon.stub().resolves(), clearActiveHookExecution: sinon.stub().resolves(),
					postStateToWebview: sinon.stub().resolves(), cancelTask: sinon.stub().resolves(),
				})
				dependencies.api.getModel = () => ({ id: "model" })
				dependencies.messageStateHandler.findMessageIndexById = () => -1
				dependencies.stateManager.getGlobalSettingsKey.withArgs("hooksEnabled").returns(true)
				const disk = require("@core/storage/disk")
				sinon.stub(disk, "writeConversationHistoryJson").resolves("context.json")
				sinon.stub(disk, "writeConversationHistoryText").resolves("context.txt")
				const cleanup = sinon.stub(disk, "cleanupConversationHistoryFile").resolves()
				sinon.stub(HookFactory.prototype, "hasHook").resolves(true)
				sinon.stub(HookFactory.prototype, "getHookInfo").resolves({ scriptPaths: ["PreCompact"] })
				const failure = fatal ? new HookCleanupError([new Error("termination failed")], "hook cleanup failed") : new Error("ordinary hook failure")
				sinon.stub(HookFactory.prototype, "createWithStreaming").resolves({ run: async () => { throw failure } } as any)
				try {
					const pending = new ApiConversationManager(dependencies).handleContextWindowExceededError()
					if (fatal) {
						await assert.rejects(pending, (error) => error === failure)
						assert.equal(dependencies.taskState.conversationHistoryDeletedRange, undefined)
						sinon.assert.notCalled(dependencies.messageStateHandler.overwriteApiConversationProviderState)
						sinon.assert.notCalled(dependencies.messageStateHandler.saveDiracMessagesAndUpdateHistory)
					} else {
						await pending
						assert.deepEqual(dependencies.taskState.conversationHistoryDeletedRange, [0, 1])
					}
					sinon.assert.calledOnce(dependencies.setActiveHookExecution)
					sinon.assert.calledOnce(dependencies.clearActiveHookExecution)
					sinon.assert.calledTwice(cleanup)
				} finally {
					sinon.restore()
				}
			})
		}

		for (const contained of [false, true]) {
			it(`forwards ${contained ? "contained" : "legacy"} storage to emergency PreCompact without changing payload identity`, async () => {
				const { dependencies } = createCompactionDependencies()
				const address = contained ? { kind: "tasklet", rootTaskId: "root", taskletId: "tasklet_00000000-0000-4000-8000-000000000001" } : undefined
				Object.assign(dependencies, {
					taskId: "logical-task", storageAddress: address,
					setActiveHookExecution: sinon.stub(), clearActiveHookExecution: sinon.stub(),
					postStateToWebview: sinon.stub(), cancelTask: sinon.stub(),
				})
				dependencies.api.getModel = () => ({ id: "model" })
				dependencies.stateManager.getGlobalSettingsKey.withArgs("hooksEnabled").returns(true)
				const hook = sinon.stub(require("@core/hooks/precompact-executor"), "executePreCompactHookWithCleanup").resolves({})
				try {
					await new ApiConversationManager(dependencies).handleContextWindowExceededError()
					assert.equal(hook.callCount, 1)
					assert.equal(hook.firstCall.args[0].taskId, dependencies.taskId)
					assert.equal(hook.firstCall.args[0].storageAddress, address)
				} finally {
					hook.restore()
				}
			})
		}

		it("enables native web search only for a capable provider with the skill active", async () => {
			const { dependencies, history } = createCompactionDependencies()
			dependencies.taskState.activeSkillIds = [NATIVE_WEB_SEARCH_SKILL_NAME]
			dependencies.api.supportsNativeWebSearch = () => true

			const enabledDispatch = await new ApiConversationManager(dependencies).prepareProviderConversationDispatch({
				systemPrompt: "system",
				tools: [],
				truncatedMessages: history,
				providerId: "openai-codex",
				modelId: "model",
			})
			assert.equal(enabledDispatch.options.enableNativeWebSearch, true)

			const { dependencies: unsupported, history: unsupportedHistory } = createCompactionDependencies()
			unsupported.api.supportsNativeWebSearch = () => false
			const disabledDispatch = await new ApiConversationManager(unsupported).prepareProviderConversationDispatch({
				systemPrompt: "system", tools: [], truncatedMessages: unsupportedHistory, providerId: "unsupported", modelId: "model",
			})
			assert.equal(disabledDispatch.options.enableNativeWebSearch, false)
		})

		it("installs a checkpoint after the condense result is in API history", async () => {
			const { dependencies, history, compactConversation, getProviderState } = createCompactionDependencies()
			dependencies.taskState.pendingApiConversationCompaction = {
				conversationHistoryDeletedRange: [0, 1],
			}
			getProviderState().deliveredSteeringMessageIds = ["transcript-1"]
			const dispatch = await new ApiConversationManager(dependencies).prepareProviderConversationDispatch({
				systemPrompt: "system",
				tools: [],
				truncatedMessages: history,
				providerId: "openai-codex",
				modelId: "model",
			})

			assert.deepEqual(compactConversation.firstCall.args[0].messages, history)
			assert.equal(getProviderState().checkpoint.compactedThroughHistoryIndex, 2)
			assert.deepEqual(dispatch.messages, [])
			assert.equal(dispatch.options.breakProviderContinuation, true)
			assert.equal(dependencies.taskState.pendingApiConversationCompaction, undefined)
			assert.deepEqual(getProviderState().deliveredSteeringMessageIds, ["transcript-1"])
		})

		it("preserves delivery receipts and sanitizes provider compaction input", async () => {
			const { dependencies, history, compactConversation, getProviderState } = createCompactionDependencies()
			history[0] = {
				role: "user",
				content: [
					{
						type: "text",
						text: "queued guidance",
						isUserInput: true,
						steeringMessageIds: ["transcript-1"],
					},
				],
			}
			getProviderState().deliveredSteeringMessageIds = ["transcript-1"]
			dependencies.taskState.pendingApiConversationCompaction = {
				conversationHistoryDeletedRange: [0, 1],
			}

			await new ApiConversationManager(dependencies).prepareProviderConversationDispatch({
				systemPrompt: "system",
				tools: [],
				truncatedMessages: history,
				providerId: "openai-codex",
				modelId: "model",
			})

			const compactedBlock = compactConversation.firstCall.args[0].messages[0].content[0]
			assert.equal("isUserInput" in compactedBlock, false)
			assert.equal("steeringMessageIds" in compactedBlock, false)
			assert.deepEqual(getProviderState().deliveredSteeringMessageIds, ["transcript-1"])
		})

		it("falls back to plaintext truncation and breaks stale continuation", async () => {
			expectLoggerErrors()
			const { dependencies, compactConversation, getProviderState } = createCompactionDependencies()
			compactConversation.rejects(new Error("compact unavailable"))
			dependencies.taskState.pendingApiConversationCompaction = {
				conversationHistoryDeletedRange: [0, 1],
			}
			const localHistory = [{ role: "user", content: "summary" }] as any
			dependencies.contextManager.getTruncatedMessages.returns(localHistory)
			const dispatch = await new ApiConversationManager(dependencies).prepareProviderConversationDispatch({
				systemPrompt: "system",
				tools: [],
				truncatedMessages: localHistory,
				providerId: "openai-codex",
				modelId: "model",
			})

			assert.deepEqual(dispatch.messages, localHistory)
			assert.equal(dispatch.options.breakProviderContinuation, true)
			assert.equal(getProviderState().checkpoint, undefined)
		})

		it("uses the openai-codex-specific auto-condense threshold", async () => {
			const { dependencies } = createCompactionDependencies()
			dependencies.stateManager.getGlobalSettingsKey.callsFake((key: string) => {
				if (key === "useAutoCondense") return true
				if (key === "autoCondenseContextLimits") return { "openai-codex": 123456 }
				return undefined
			})
			dependencies.contextManager.shouldCompactContextWindow.returns(true)

			await new ApiConversationManager(dependencies).determineContextCompaction(4)

			assert.equal(dependencies.contextManager.shouldCompactContextWindow.firstCall.args[3], 123456)
		})

		it("recompacts the active checkpoint plus only its post-checkpoint suffix", async () => {
			const { dependencies, history, compactConversation, getProviderState } = createCompactionDependencies()
			const priorCheckpoint = {
				providerId: "openai-codex",
				modelId: "model",
				compactedThroughHistoryIndex: 0,
				input: [{ type: "compaction", encrypted_content: "prior-opaque" }],
			}
			getProviderState().checkpoint = priorCheckpoint
			dependencies.taskState.pendingApiConversationCompaction = {
				conversationHistoryDeletedRange: [0, 1],
			}

			await new ApiConversationManager(dependencies).prepareProviderConversationDispatch({
				systemPrompt: "system",
				tools: [],
				truncatedMessages: history,
				providerId: "openai-codex",
				modelId: "model",
			})

			assert.equal(compactConversation.firstCall.args[0].checkpoint, priorCheckpoint)
			assert.deepEqual(compactConversation.firstCall.args[0].messages, history.slice(1))
		})

		it("schedules provider compaction after emergency plaintext truncation", async () => {
			const { dependencies, getProviderState } = createCompactionDependencies()
			dependencies.taskState.conversationHistoryDeletedRange = [0, 0]
			dependencies.contextManager.getNextTruncationRange.returns([0, 1])

			await new ApiConversationManager(dependencies).handleContextWindowExceededError()

			assert.deepEqual(dependencies.taskState.pendingApiConversationCompaction, {
				conversationHistoryDeletedRange: [0, 1],
				previousConversationHistoryDeletedRange: [0, 0],
			})
			assert.deepEqual(getProviderState().pendingCompaction, {
				conversationHistoryDeletedRange: [0, 1],
				previousConversationHistoryDeletedRange: [0, 0],
			})
		})

		it("resumes a persisted pending compaction after restart", async () => {
			const { dependencies, compactConversation, getProviderState } = createCompactionDependencies()
			getProviderState().pendingCompaction = {
				conversationHistoryDeletedRange: [0, 1],
				previousConversationHistoryDeletedRange: [0, 0],
			}

			await new ApiConversationManager(dependencies).prepareProviderConversationDispatch({
				systemPrompt: "system",
				tools: [],
				truncatedMessages: [],
				providerId: "openai-codex",
				modelId: "model",
			})

			assert.equal(compactConversation.callCount, 1)
			assert.equal(getProviderState().pendingCompaction, undefined)
		})

		it("restores the persisted target truncation range before plaintext fallback", async () => {
			const { dependencies, getProviderState } = createCompactionDependencies()
			const targetMessages = [{ role: "user", content: "retained summary" }] as any
			dependencies.api = {}
			dependencies.taskState.conversationHistoryDeletedRange = [0, 0]
			dependencies.contextManager.getTruncatedMessages.returns(targetMessages)
			getProviderState().pendingCompaction = {
				conversationHistoryDeletedRange: [1, 2],
				previousConversationHistoryDeletedRange: [0, 0],
			}

			const dispatch = await new ApiConversationManager(dependencies).prepareProviderConversationDispatch({
				systemPrompt: "system",
				tools: [],
				truncatedMessages: [{ role: "user", content: "stale range" }] as any,
				providerId: "openai-codex",
				modelId: "model",
			})

			assert.deepEqual(dependencies.taskState.conversationHistoryDeletedRange, [1, 2])
			assert.deepEqual(dispatch.messages, targetMessages)
			assert.equal(dependencies.messageStateHandler.saveDiracMessagesAndUpdateHistory.callCount, 1)
			assert.equal(getProviderState().pendingCompaction, undefined)
		})

		it("propagates cancellation without consuming pending compaction", async () => {
			const { dependencies, compactConversation } = createCompactionDependencies()
			const abortError = new Error("aborted")
			compactConversation.callsFake(async () => {
				dependencies.taskState.abort = true
				throw abortError
			})
			dependencies.taskState.pendingApiConversationCompaction = {
				conversationHistoryDeletedRange: [0, 1],
			}

			await assert.rejects(
				new ApiConversationManager(dependencies).prepareProviderConversationDispatch({
					systemPrompt: "system",
					tools: [],
					truncatedMessages: [],
					providerId: "openai-codex",
					modelId: "model",
				}),
				(error) => error === abortError,
			)

			assert.notEqual(dependencies.taskState.pendingApiConversationCompaction, undefined)
			assert.equal(dependencies.messageStateHandler.overwriteApiConversationProviderState.callCount, 0)
		})

		it("propagates cancellation that occurs while compacted state is persisted", async () => {
			const { dependencies } = createCompactionDependencies()
			dependencies.taskState.pendingApiConversationCompaction = {
				conversationHistoryDeletedRange: [0, 1],
			}
			dependencies.messageStateHandler.overwriteApiConversationProviderState.callsFake(async () => {
				dependencies.taskState.abort = true
			})

			await assert.rejects(
				new ApiConversationManager(dependencies).prepareProviderConversationDispatch({
					systemPrompt: "system",
					tools: [],
					truncatedMessages: [],
					providerId: "openai-codex",
					modelId: "model",
				}),
				/Task instance aborted/,
			)
		})

		it("skips the pre-condense token sample once after a successful condense", async () => {
			const { dependencies } = createCompactionDependencies()
			dependencies.stateManager.getGlobalSettingsKey.withArgs("useAutoCondense").returns(true)
			dependencies.taskState.skipNextAutoCondenseCheck = true

			const shouldCompact = await new ApiConversationManager(dependencies).determineContextCompaction(4)

			assert.equal(shouldCompact, false)
			assert.equal(dependencies.taskState.skipNextAutoCondenseCheck, false)
			assert.equal(dependencies.contextManager.shouldCompactContextWindow.callCount, 0)
		})
	})
})
