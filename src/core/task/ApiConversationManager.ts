import { getTaskHookModelContext } from "./runtime/TaskRuntimeModelContext"
import { getHooksEnabledSafe } from "@core/hooks/hooks-utils"
import { executePreCompactHookWithCleanup, HookCancellationError } from "@core/hooks/precompact-executor"
import { autoCondensePrompt } from "@core/prompts/contextManagement"
import type { SlashCommandDirectAction } from "@core/slash-commands"
import type { ApiConversationCheckpoint, ApiConversationRequestOptions } from "@core/api/conversation"
import { formatContentBlockToMarkdown } from "@integrations/misc/export-markdown"
import { telemetryService } from "@services/telemetry"
import { CardStatus, Mode } from "@shared/ExtensionMessage"
import { DiracContent, DiracStorageMessage, removeProviderBoundaryMetadataFromMessage } from "@shared/messages/content"
import type { DiracTool } from "@shared/tools"
import { NATIVE_WEB_SEARCH_SKILL_NAME } from "@shared/skills"
import { Logger } from "@shared/services/Logger"
import { getAutoCondenseContextLimit } from "@shared/context-management"
import { ApiConversationManagerDependencies } from "./types/api-conversation-manager"

export class ApiConversationManager {
	constructor(private dependencies: ApiConversationManagerDependencies) { }

	setApi(api: ApiConversationManagerDependencies["api"]): void {
		this.dependencies.api = api
	}

	private getOperationalApi(): ApiConversationManagerDependencies["api"] {
		return this.dependencies.getRequestRuntime()?.api ?? this.dependencies.api
	}

	public async scheduleProviderConversationCompaction(
		previousConversationHistoryDeletedRange: [number, number] | undefined,
		conversationHistoryDeletedRange: [number, number],
	): Promise<void> {
		const pendingCompaction = { previousConversationHistoryDeletedRange, conversationHistoryDeletedRange }
		this.dependencies.taskState.pendingApiConversationCompaction = pendingCompaction
		const providerState = this.dependencies.messageStateHandler.getApiConversationProviderState()
		await this.dependencies.messageStateHandler.overwriteApiConversationProviderState({
			...providerState,
			pendingCompaction,
		})
	}

	public calculatePreCompactDeletedRange(apiConversationHistory: DiracStorageMessage[]): [number, number] {
		const newDeletedRange = this.dependencies.contextManager.getNextTruncationRange(
			apiConversationHistory,
			this.dependencies.taskState.conversationHistoryDeletedRange,
			"quarter", // Force aggressive truncation on error
		)

		return newDeletedRange || [0, 0]
	}

	public async handleContextWindowExceededError(): Promise<void> {
		const apiConversationHistory = this.dependencies.messageStateHandler.getApiConversationHistory()

		// Run PreCompact hook before truncation
		const hooksEnabled = getHooksEnabledSafe(this.dependencies.getWorkingConfiguration().settings.hooksEnabled)
		if (hooksEnabled) {
			try {
				// Calculate what the new deleted range will be
				const deletedRange = this.calculatePreCompactDeletedRange(apiConversationHistory)

				// Execute hook - throws HookCancellationError if cancelled
				await executePreCompactHookWithCleanup({
					taskId: this.dependencies.taskId,
					storageAddress: this.dependencies.storageAddress,
					ulid: this.dependencies.ulid,
					modelContext: getTaskHookModelContext(
						this.getOperationalApi(),
						this.dependencies.getRequestRuntime()?.workingConfiguration ?? this.dependencies.getWorkingConfiguration(),
					),
					apiConversationHistory,
					conversationHistoryDeletedRange: this.dependencies.taskState.conversationHistoryDeletedRange,
					contextManager: this.dependencies.contextManager,
					diracMessages: this.dependencies.messageStateHandler.getDiracMessages(),
					messageStateHandler: this.dependencies.messageStateHandler,
					compactionStrategy: "standard-truncation-lastquarter",
					deletedRange,
					messenger: this.dependencies.taskMessenger,
					setActiveHookExecution: this.dependencies.setActiveHookExecution.bind(this.dependencies),
					clearActiveHookExecution: this.dependencies.clearActiveHookExecution.bind(this.dependencies),
					postStateToWebview: this.dependencies.postStateToWebview.bind(this.dependencies),
					taskState: this.dependencies.taskState,
					cancelTask: this.dependencies.cancelTask.bind(this.dependencies),
					hooksEnabled,
				})
			} catch (error) {
				// If hook was cancelled, re-throw to stop compaction
				if (error instanceof HookCancellationError) {
					throw error
				}

				// Graceful degradation: Log error but continue with truncation
				Logger.error("[PreCompact] Hook execution failed:", error)
			}
		}

		// Proceed with standard truncation
		const previousConversationHistoryDeletedRange = this.dependencies.taskState.conversationHistoryDeletedRange
		const newDeletedRange = this.dependencies.contextManager.getNextTruncationRange(
			apiConversationHistory,
			previousConversationHistoryDeletedRange,
			"quarter", // Force aggressive truncation
		)

		this.dependencies.taskState.conversationHistoryDeletedRange = newDeletedRange
		if (newDeletedRange) {
			await this.scheduleProviderConversationCompaction(previousConversationHistoryDeletedRange, newDeletedRange)
		}

		await this.dependencies.messageStateHandler.saveDiracMessagesAndUpdateHistory()
		this.dependencies.onContextCompacted?.()
	}

	public async determineContextCompaction(previousApiReqIndex: number): Promise<boolean> {
		const useAutoCondense = this.dependencies.getRequestRuntime()?.workingConfiguration.settings.useAutoCondense ??
			this.dependencies.getWorkingConfiguration().settings.useAutoCondense
		if (!useAutoCondense) return false

		if (this.dependencies.taskState.skipNextAutoCondenseCheck) {
			this.dependencies.taskState.skipNextAutoCondenseCheck = false
			return false
		}

		const providerId = this.dependencies.getCurrentProviderInfo().providerId
		const configuredLimit = getAutoCondenseContextLimit(
			(this.dependencies.getRequestRuntime()?.workingConfiguration ?? this.dependencies.getWorkingConfiguration()).settings.autoCondenseContextLimits,
			providerId,
		)
		const shouldCompact = this.dependencies.contextManager.shouldCompactContextWindow(
			this.dependencies.messageStateHandler.getDiracMessages(),
			this.getOperationalApi(),
			previousApiReqIndex,
			configuredLimit,
		)
		if (!shouldCompact || !this.dependencies.taskState.conversationHistoryDeletedRange) {
			return shouldCompact
		}

		const apiHistory = this.dependencies.messageStateHandler.getApiConversationHistory()
		const activeMessageCount = apiHistory.length - this.dependencies.taskState.conversationHistoryDeletedRange[1] - 1

		// The next user message has not been appended yet, so an already-condensed
		// conversation has zero or two active messages at this point.
		return activeMessageCount > 2
	}
	private isCompatibleCheckpoint(
		checkpoint: ApiConversationCheckpoint | undefined,
		providerId: string,
		modelId: string,
		historyLength: number,
	): checkpoint is ApiConversationCheckpoint {
		return (
			checkpoint?.providerId === providerId &&
			checkpoint.modelId === modelId &&
			checkpoint.compactedThroughHistoryIndex >= 0 &&
			checkpoint.compactedThroughHistoryIndex < historyLength
		)
	}

	private hasCompatibleAssistantAfterBoundary(
		history: DiracStorageMessage[],
		boundary: number,
		providerId: string,
		modelId: string,
	): boolean {
		return history
			.slice(boundary + 1)
			.some(
				(message) =>
					message.role === "assistant" &&
					message.modelInfo?.providerId === providerId &&
					message.modelInfo.modelId === modelId &&
					message.id !== undefined,
			)
	}

	public async prepareProviderConversationDispatch(params: {
		systemPrompt: string
		tools: DiracTool[]
		truncatedMessages: DiracStorageMessage[]
		providerId: string
		modelId: string
	}): Promise<{ messages: DiracStorageMessage[]; options: ApiConversationRequestOptions }> {
		if (this.dependencies.taskState.abort) throw new Error("Task instance aborted")

		const fullHistory = this.dependencies.messageStateHandler.getApiConversationHistory()
		let providerState = this.dependencies.messageStateHandler.getApiConversationProviderState()
		let checkpoint = this.isCompatibleCheckpoint(
			providerState.checkpoint,
			params.providerId,
			params.modelId,
			fullHistory.length,
		)
			? providerState.checkpoint
			: undefined

		let dispatchMessages = params.truncatedMessages

		const pendingCompaction = this.dependencies.taskState.pendingApiConversationCompaction ?? providerState.pendingCompaction
		if (pendingCompaction) this.dependencies.taskState.pendingApiConversationCompaction = pendingCompaction
		if (pendingCompaction) {
			const currentDeletedRange = this.dependencies.taskState.conversationHistoryDeletedRange
			const targetDeletedRange = pendingCompaction.conversationHistoryDeletedRange
			if (
				!currentDeletedRange ||
				currentDeletedRange[0] !== targetDeletedRange[0] ||
				currentDeletedRange[1] !== targetDeletedRange[1]
			) {
				this.dependencies.taskState.conversationHistoryDeletedRange = targetDeletedRange
				dispatchMessages = this.dependencies.contextManager.getTruncatedMessages(
					fullHistory,
					targetDeletedRange,
				) as DiracStorageMessage[]
				await this.dependencies.messageStateHandler.saveDiracMessagesAndUpdateHistory()
			}
			const boundary = fullHistory.length - 1
			const api = this.getOperationalApi()
			if (api.compactConversation) {
				const messages = checkpoint
					? fullHistory.slice(checkpoint.compactedThroughHistoryIndex + 1)
					: (this.dependencies.contextManager.getTruncatedMessages(
						fullHistory,
						pendingCompaction.previousConversationHistoryDeletedRange,
					) as DiracStorageMessage[])
				try {
					const result = await api.compactConversation({
						systemPrompt: params.systemPrompt,
						messages: messages.map(removeProviderBoundaryMetadataFromMessage),
						tools: params.tools,
						checkpoint,
					})
					if (this.dependencies.taskState.abort) throw new Error("Task instance aborted")
					checkpoint = {
						providerId: params.providerId,
						modelId: params.modelId,
						compactedThroughHistoryIndex: boundary,
						input: result.input,
					}
					providerState = {
						...providerState,
						checkpoint,
						continuationReset: {
							providerId: params.providerId,
							modelId: params.modelId,
							compactedThroughHistoryIndex: boundary,
						},
						pendingCompaction: undefined,
					}
					await this.dependencies.messageStateHandler.overwriteApiConversationProviderState(providerState)
					this.dependencies.taskState.pendingApiConversationCompaction = undefined
				} catch (error) {
					if (this.dependencies.taskState.abort) throw error
					Logger.error(
						"Provider-native conversation compaction failed; using the plaintext condensed history without opaque state preservation:",
						error,
					)
					checkpoint = undefined
					providerState = {
						...providerState,
						checkpoint: undefined,
						continuationReset: {
							providerId: params.providerId,
							modelId: params.modelId,
							compactedThroughHistoryIndex: boundary,
						},
						pendingCompaction: undefined,
					}
					await this.dependencies.messageStateHandler.overwriteApiConversationProviderState(providerState)
					this.dependencies.taskState.pendingApiConversationCompaction = undefined
				}
			} else {
				Logger.warn(
					"Provider-native conversation compaction is unavailable; using the plaintext condensed history without opaque state preservation.",
				)
				checkpoint = undefined
				providerState = {
					...providerState,
					checkpoint: undefined,
					continuationReset: {
						providerId: params.providerId,
						modelId: params.modelId,
						compactedThroughHistoryIndex: boundary,
					},
					pendingCompaction: undefined,
				}
				await this.dependencies.messageStateHandler.overwriteApiConversationProviderState(providerState)
				this.dependencies.taskState.pendingApiConversationCompaction = undefined
			}
		}

		const continuationReset = providerState.continuationReset
		const resetIsCompatible =
			continuationReset?.providerId === params.providerId && continuationReset.modelId === params.modelId
		let breakProviderContinuation = resetIsCompatible
		if (
			resetIsCompatible &&
			this.hasCompatibleAssistantAfterBoundary(
				fullHistory,
				continuationReset.compactedThroughHistoryIndex,
				params.providerId,
				params.modelId,
			)
		) {
			providerState = { ...providerState, continuationReset: undefined }
			await this.dependencies.messageStateHandler.overwriteApiConversationProviderState(providerState)
			breakProviderContinuation = false
		}

		if (providerState.checkpoint && !checkpoint) {
			providerState = { ...providerState, checkpoint: undefined }
			await this.dependencies.messageStateHandler.overwriteApiConversationProviderState(providerState)
		}

		if (this.dependencies.taskState.abort) throw new Error("Task instance aborted")

		const enableNativeWebSearch =
			this.getOperationalApi().supportsNativeWebSearch?.() === true &&
			this.dependencies.taskState.activeSkillIds.includes(NATIVE_WEB_SEARCH_SKILL_NAME)

		return {
			messages: checkpoint ? fullHistory.slice(checkpoint.compactedThroughHistoryIndex + 1) : dispatchMessages,
			options: { checkpoint, breakProviderContinuation, enableNativeWebSearch },
		}
	}

	public async prepareApiRequest(params: {
		userContent: DiracContent[]
		shouldCompact?: boolean
		includeFileDetails: boolean
		useCompactPrompt: boolean
		previousApiReqIndex: number
		directResponseText?: string
		popover?: boolean
		isFirstRequest: boolean
		providerId: string
		modelId: string
		mode: string
		requestId: string
		afterUserContentPersisted?: () => Promise<void>
	}): Promise<{
		userContent: DiracContent[]
		lastApiReqIndex: number
		isDirectResponse?: boolean
		directResponseText?: string
		didConsumeUserContent: boolean
	}> {
		let nextUserContent = params.userContent

		// 1. Run User Prompt Submit Hook
		const hookResult = await this.dependencies.runUserPromptSubmitHook(
			nextUserContent,
			params.isFirstRequest ? "initial_task" : "feedback",
		)
		if (hookResult.cancel) {
			return {
				userContent: nextUserContent,
				lastApiReqIndex: params.previousApiReqIndex,
				isDirectResponse: true,
				directResponseText: hookResult.errorMessage,
				didConsumeUserContent: false,
			}
		}

		let parsedUserContent: DiracContent[]
		let environmentDetails: string
		let diracrulesError: boolean
		let isDirectResponse = false
		let directResponseText = params.directResponseText
		let directActions: SlashCommandDirectAction[] | undefined

		if (params.shouldCompact) {
			parsedUserContent = [...nextUserContent]
			environmentDetails = ""
			diracrulesError = false
			this.dependencies.taskState.lastAutoCondenseTriggerIndex = params.previousApiReqIndex
			this.dependencies.taskState.pendingCondenseSource = "automatic"
		} else {
			const [
				loadedUserContent,
				loadedEnvironmentDetails,
				loadedDiracrulesError,
				availableSkills,
				loadedIsDirectResponse,
				loadedDirectResponseText,
				loadedDirectActions,
			] = await this.dependencies.loadContext(nextUserContent, params.includeFileDetails, params.useCompactPrompt)
			parsedUserContent = loadedUserContent
			environmentDetails = loadedEnvironmentDetails
			diracrulesError = loadedDiracrulesError
			isDirectResponse = loadedIsDirectResponse
			directResponseText = loadedDirectResponseText ?? params.directResponseText
			directActions = loadedDirectActions
			this.dependencies.taskState.availableSkills = availableSkills
		}

		const skillIds = [
			...new Set(
				(directActions ?? []).flatMap((action) => (action.type === "activateSkill" ? [action.skillId] : [])),
			),
		]
		for (const skillId of skillIds) {
			await this.dependencies.activateSkill(skillId)
		}

		if (directActions?.some((action) => action.type === "condenseConversation")) {
			const continuation = await this.dependencies.runLocalConversationCompaction("user")
			if (!continuation) {
				return {
					userContent: parsedUserContent,
					lastApiReqIndex: params.previousApiReqIndex,
					isDirectResponse: true,
					didConsumeUserContent: true,
				}
			}
			parsedUserContent.unshift({ type: "text", text: continuation })
			const pinnedContext = this.dependencies.getPinnedContext?.()
			if (pinnedContext) parsedUserContent.splice(1, 0, { type: "text", text: pinnedContext })
		}

		if (isDirectResponse) {
			return {
				userContent: directResponseText ? [{ type: "text", text: directResponseText }] : parsedUserContent,
				lastApiReqIndex: -1,
				isDirectResponse: true,
				directResponseText,
				didConsumeUserContent: true,
			}
		}

		// error handling if the user uses the /newrule command & their .diracrules is a file, for file read operations didnt work properly
		if (diracrulesError === true) {
			const card = await this.dependencies.taskMessenger.createCard({
				header: "Rule Error",
				body: "Issue with processing the /newrule command. Double check that, if '.diracrules' already exists, it's a directory and not a file. Otherwise there was an issue referencing this file/directory.",
				status: CardStatus.ERROR,
			})
			await card.finalize(CardStatus.ERROR)
		}

		// Replace userContent with parsed content that includes file details and command instructions.
		const userContent = parsedUserContent

		// add environment details as its own text block, separate from tool results
		// do not add environment details to the message which we are compacting the context window
		if (environmentDetails) {
			userContent.push({ type: "text", text: environmentDetails })
		}

		if (params.shouldCompact) {
			const pinnedContext = this.dependencies.getPinnedContext?.()
			if (pinnedContext) userContent.push({ type: "text", text: pinnedContext })
			userContent.push({ type: "text", text: autoCondensePrompt() })
		}

		// getting verbose details is an expensive operation, it uses globby to top-down build file structure of project which for large projects can take a few seconds
		// for the best UX we show a placeholder api_req_started message with a loading spinner as this happens
		const apiReqId = `api-req-${Date.now()}`
		await this.dependencies.taskMessenger.upsertApiStatus({
			id: apiReqId,
			request: userContent.map((block) => formatContentBlockToMarkdown(block)).join("\n\n") + "\n\nLoading...",
		})

		telemetryService.captureConversationTurnEvent(
			this.dependencies.ulid,
			params.providerId,
			params.modelId,
			"user",
			params.mode as Mode,
			undefined,
			this.dependencies.taskState.useNativeToolCalls,
		)

		// Capture task initialization timing telemetry for the first API request
		if (params.isFirstRequest) {
			const durationMs = Math.round(performance.now() - this.dependencies.taskInitializationStartTime)
			telemetryService.captureTaskInitialization(
				this.dependencies.ulid,
				this.dependencies.taskId,
				durationMs,
				(this.dependencies.getRequestRuntime()?.workingConfiguration ?? this.dependencies.getWorkingConfiguration()).settings.enableCheckpointsSetting,
			)
		}

		// since we sent off a placeholder api_req_started message to update the webview while waiting to actually start the API request (to load potential details for example), we need to update the text of that message
		const lastApiReqIndex = this.dependencies.messageStateHandler.findMessageIndexById(apiReqId)
		if (lastApiReqIndex === -1) throw new Error(`API status ${apiReqId} not found`)
		await this.dependencies.messageStateHandler.patchApiStatusById(apiReqId, {
			request: userContent.map((block) => formatContentBlockToMarkdown(block)).join("\n\n"),
		})

		await this.dependencies.postStateToWebview()

		await this.dependencies.messageStateHandler.addToApiConversationHistory({
			role: "user",
			content: userContent,
			ts: Date.now(),
		})
		const modeNotice = this.dependencies.taskState.pendingModeNotice
		if (
			!params.shouldCompact &&
			modeNotice?.mode === params.mode &&
			modeNotice.includedInRequestId === params.requestId
		) {
			this.dependencies.taskState.pendingModeNotice = undefined
		}
		await params.afterUserContentPersisted?.()

		return { userContent, lastApiReqIndex, directResponseText, didConsumeUserContent: true }
	}
}
