import { type ApiHandler, buildApiHandlerForSelection } from "@core/api"
import type { ContextManager } from "@core/context/context-management/ContextManager"
import { getTaskHookModelContext } from "./runtime/TaskRuntimeModelContext"
import { getHooksEnabledSafe } from "@core/hooks/hooks-utils"
import { executePreCompactHookWithCleanup, HookCancellationError } from "@core/hooks/precompact-executor"
import { continuationPrompt } from "@core/prompts/contextManagement"
import type { TaskWorkingConfiguration } from "./runtime/TaskWorkingConfiguration"
import { ConversationCondensationService } from "@core/text-condensation/ConversationCondensationService"
import {
	CONVERSATION_CONTINUATION_TEMPLATE_ID,
	createDefaultTextCondensationTemplateRegistry,
} from "@core/text-condensation/templates"
import { UtilityModelTextCondenser } from "@core/text-condensation/UtilityModelTextCondenser"
import {
	getConfiguredUtilityModelSelection,
	isUtilityTextCondensationAvailable,
} from "@core/text-condensation/UtilityTextCondensationAvailability"
import {
	UtilityModelCancelledError,
	UtilityModelRunner,
	type UtilityModelHandlerFactory,
	type UtilityModelRunnerOptions,
} from "@core/utility-model/UtilityModelRunner"
import type { ApiConfiguration, ModelProviderSelection } from "@shared/api"
import { CardStatus } from "@shared/ExtensionMessage"
import { DiracIcon } from "@shared/icons"
import { Logger } from "@shared/services/Logger"
import { stripHashes } from "@shared/utils/line-hashing"
import { getErrorMessage } from "@/shared/errors"
import type { MessageStateHandler } from "./message-state"
import type { TaskMessenger } from "./TaskMessenger"
import type { TaskState } from "./TaskState"
import { recordUtilityModelUsage } from "./recordUtilityModelUsage"
import type { HookExecution } from "./types/HookExecution"

export type LocalConversationCompactionSource = "automatic" | "user"

interface LocalConversationCompactionDependencies {
	taskId: string
	ulid: string
	taskState: TaskState
	messageStateHandler: MessageStateHandler
	contextManager: ContextManager
	getWorkingConfiguration: () => TaskWorkingConfiguration
	taskMessenger: TaskMessenger
	getApi: () => ApiHandler
	postStateToWebview: () => Promise<void>
	cancelTask: () => Promise<void>
	setActiveHookExecution: (hookExecution: HookExecution | undefined) => Promise<void>
	clearActiveHookExecution: () => Promise<void>
	onContextCompacted?: () => void
}

interface LocalConversationCompactionOptions {
	source: LocalConversationCompactionSource
	triggerApiRequestIndex?: number
}

interface UtilityModelIdentity {
	providerId: string
	modelId: string
}

/**
 * Runs conversation condensation outside the active model/tool loop. The Utility
 * model produces and validates the summary before any conversation state changes.
 */
export class LocalConversationCompaction {
	constructor(private readonly dependencies: LocalConversationCompactionDependencies) { }

	isAvailable(): boolean {
		return isUtilityTextCondensationAvailable(
			{
				utilityModelEnabled: this.dependencies.getWorkingConfiguration().settings.utilityModelEnabled,
				utilityModelUseCondense: this.dependencies.getWorkingConfiguration().settings.utilityModelUseCondense,
				utilityModelUseNewTask: this.dependencies.getWorkingConfiguration().settings.utilityModelUseNewTask,
				utilityModelSelection: this.dependencies.getWorkingConfiguration().settings.utilityModelSelection,
			},
			CONVERSATION_CONTINUATION_TEMPLATE_ID,
			createDefaultTextCondensationTemplateRegistry(),
		)
	}

	async run(options: LocalConversationCompactionOptions): Promise<string | undefined> {
		const templates = createDefaultTextCondensationTemplateRegistry()
		const settings = {
			utilityModelEnabled: this.dependencies.getWorkingConfiguration().settings.utilityModelEnabled,
			utilityModelUseCondense: this.dependencies.getWorkingConfiguration().settings.utilityModelUseCondense,
			utilityModelUseNewTask: this.dependencies.getWorkingConfiguration().settings.utilityModelUseNewTask,
			utilityModelSelection: this.dependencies.getWorkingConfiguration().settings.utilityModelSelection,
		}
		const selection = getConfiguredUtilityModelSelection(settings.utilityModelSelection)
		const configuredIdentity = this.getConfiguredIdentity(settings.utilityModelSelection)

		if (!selection || !this.isAvailable()) return undefined

		const configuration = structuredClone(this.dependencies.getWorkingConfiguration().apiConfiguration) as ApiConfiguration
		const createHandler = () => buildApiHandlerForSelection(configuration, selection, { ulid: this.dependencies.ulid })
		let identity: UtilityModelIdentity
		try {
			const handler = createHandler()
			identity = {
				providerId: selection.provider,
				modelId: handler.getModel().id,
			}
		} catch (error) {
			await this.displayFailure(configuredIdentity, error)
			return undefined
		}

		const card = await this.dependencies.taskMessenger.createCard({
			header: `Condensing Conversation · ${this.formatIdentity(identity)}`,
			status: CardStatus.RUNNING,
			icon: DiracIcon.SUMMARIZE,
			collapsed: false,
		})

		let summary: string
		let continuation: string
		try {
			summary = await this.generateSummary(selection, createHandler, templates, async ({ retryAttempt, maxRetries, delayMs, error }) => {
				await card.update({
					header: `Condensing Conversation (retry ${retryAttempt}/${maxRetries}) · ${this.formatIdentity(identity)}`,
					body: `Utility request failed. Retrying in ${delayMs / 1000}s...\n\n${getErrorMessage(error)}`,
				})
			})
			this.throwIfCancelled()
			const range = this.dependencies.contextManager.getNextTruncationRange(
				this.dependencies.messageStateHandler.getApiConversationHistory(),
				this.dependencies.taskState.conversationHistoryDeletedRange,
				"lastTwo",
			)
			const contextModification = await this.runPreCompactHook(options.source, range)
			this.throwIfCancelled()

			continuation = continuationPrompt(summary)
			if (contextModification) {
				continuation += `\n\n[Context Modification from PreCompact Hook]\n${contextModification}`
			}

			await this.applyCompaction(range, options.triggerApiRequestIndex)
		} catch (error) {
			const cancelled =
				this.dependencies.taskState.abort ||
				error instanceof UtilityModelCancelledError ||
				error instanceof HookCancellationError
			const status = cancelled ? CardStatus.CANCELLED : CardStatus.ERROR
			const state = cancelled ? "Cancelled" : "Failed"
			await card.update({
				header: `Conversation Condensation ${state} · ${this.formatIdentity(identity)}`,
				status,
				body: cancelled
					? "Conversation condensation was cancelled. The conversation was not compacted."
					: this.buildFailureBody(error),
				collapsed: false,
			})
			await card.finalize(status, true)
			if (!cancelled) Logger.error("Local Utility conversation condensation failed", error)
			return undefined
		}

		try {
			await card.update({
				header: `Conversation Condensed · ${this.formatIdentity(identity)}`,
				status: CardStatus.SUCCESS,
				body: stripHashes(summary),
				renderType: "markdown",
				collapsed: true,
			})
			await card.finalize(CardStatus.SUCCESS)
		} catch (error) {
			Logger.error("Failed to present completed local conversation condensation", error)
		}

		try {
			this.dependencies.onContextCompacted?.()
		} catch (error) {
			Logger.error("Local conversation compaction observer failed", error)
		}

		return continuation
	}

	private throwIfCancelled(): void {
		if (this.dependencies.taskState.abort) throw new UtilityModelCancelledError()
	}

	private async generateSummary(
		selection: ModelProviderSelection,
		createHandler: UtilityModelHandlerFactory,
		templates: ReturnType<typeof createDefaultTextCondensationTemplateRegistry>,
		onRetry: UtilityModelRunnerOptions["onRetry"],
	): Promise<string> {
		const runner = new UtilityModelRunner(selection, createHandler, {
			onRetry,
			onUsage: (event) => recordUtilityModelUsage(this.dependencies.taskState, this.dependencies.ulid, event),
		})
		const textCondenser = new UtilityModelTextCondenser(runner, templates)
		const service = new ConversationCondensationService({
			messageState: this.dependencies.messageStateHandler,
			contextManager: this.dependencies.contextManager,
			getConversationHistoryDeletedRange: () => this.dependencies.taskState.conversationHistoryDeletedRange,
			textCondenser,
		})
		return await service.condenseConversation(CONVERSATION_CONTINUATION_TEMPLATE_ID, {
			historyScope: "effective",
			signal: this.dependencies.taskState.abortSignal,
		})
	}

	private async runPreCompactHook(
		source: LocalConversationCompactionSource,
		range: [number, number],
	): Promise<string | undefined> {
		const hooksEnabled = getHooksEnabledSafe(this.dependencies.getWorkingConfiguration().settings.hooksEnabled)
		if (!hooksEnabled) return undefined

		const result = await executePreCompactHookWithCleanup({
			taskId: this.dependencies.taskId,
			ulid: this.dependencies.ulid,
			modelContext: getTaskHookModelContext(this.dependencies.getApi(), this.dependencies.getWorkingConfiguration()),
			apiConversationHistory: this.dependencies.messageStateHandler.getApiConversationHistory(),
			conversationHistoryDeletedRange: this.dependencies.taskState.conversationHistoryDeletedRange,
			contextManager: this.dependencies.contextManager,
			diracMessages: this.dependencies.messageStateHandler.getDiracMessages(),
			messageStateHandler: this.dependencies.messageStateHandler,
			compactionStrategy: source === "automatic" ? "auto-condense" : "user-condense",
			deletedRange: range,
			messenger: this.dependencies.taskMessenger,
			setActiveHookExecution: this.dependencies.setActiveHookExecution,
			clearActiveHookExecution: this.dependencies.clearActiveHookExecution,
			postStateToWebview: this.dependencies.postStateToWebview,
			taskState: this.dependencies.taskState,
			cancelTask: this.dependencies.cancelTask,
			hooksEnabled,
			cancelTaskOnCancellation: false,
		})
		return result.contextModification
	}

	private async applyCompaction(range: [number, number], triggerApiRequestIndex?: number): Promise<void> {
		const previousRange = this.dependencies.taskState.conversationHistoryDeletedRange
		const previousSkip = this.dependencies.taskState.skipNextAutoCondenseCheck
		const previousPending = this.dependencies.taskState.pendingApiConversationCompaction
		const previousTrigger = this.dependencies.taskState.lastAutoCondenseTriggerIndex
		const previousProviderState = this.dependencies.messageStateHandler.getApiConversationProviderState()
		const pendingCompaction = {
			previousConversationHistoryDeletedRange: previousRange,
			conversationHistoryDeletedRange: range,
		}

		this.throwIfCancelled()
		try {
			await this.dependencies.messageStateHandler.overwriteApiConversationProviderState({
				...previousProviderState,
				pendingCompaction,
			})
			this.throwIfCancelled()

			this.dependencies.taskState.conversationHistoryDeletedRange = range
			this.dependencies.taskState.skipNextAutoCondenseCheck = true
			this.dependencies.taskState.pendingApiConversationCompaction = pendingCompaction
			if (triggerApiRequestIndex !== undefined) {
				this.dependencies.taskState.lastAutoCondenseTriggerIndex = triggerApiRequestIndex
			}
			await this.dependencies.messageStateHandler.saveDiracMessagesAndUpdateHistory()
			this.throwIfCancelled()
		} catch (error) {
			this.dependencies.taskState.conversationHistoryDeletedRange = previousRange
			this.dependencies.taskState.skipNextAutoCondenseCheck = previousSkip
			this.dependencies.taskState.pendingApiConversationCompaction = previousPending
			this.dependencies.taskState.lastAutoCondenseTriggerIndex = previousTrigger
			await this.dependencies.messageStateHandler.overwriteApiConversationProviderState(previousProviderState)
			await this.dependencies.messageStateHandler.saveDiracMessagesAndUpdateHistory()
			throw error
		}
	}


	private async displayFailure(identity: UtilityModelIdentity | undefined, error: unknown): Promise<void> {
		const card = await this.dependencies.taskMessenger.createCard({
			header: `Conversation Condensation Failed · ${identity ? this.formatIdentity(identity) : "Utility model unavailable"}`,
			status: CardStatus.ERROR,
			icon: DiracIcon.SUMMARIZE,
			body: this.buildFailureBody(error),
			collapsed: false,
		})
		await card.finalize(CardStatus.ERROR, true)
		Logger.error("Failed to initialize Utility conversation condensation", error)
	}

	private buildFailureBody(error: unknown): string {
		const message = getErrorMessage(error)
		return `Utility-model conversation condensation failed. Fix or change the configured Utility model, then retry.\n\n${message}`
	}

	private getConfiguredIdentity(selection: unknown): UtilityModelIdentity | undefined {
		if (!selection || typeof selection !== "object") return undefined
		const { provider, modelId } = selection as {
			provider?: unknown
			modelId?: unknown
		}
		if (typeof provider !== "string" || typeof modelId !== "string") return undefined
		return { providerId: provider, modelId }
	}

	private formatIdentity(identity: UtilityModelIdentity): string {
		return `${identity.providerId}/${identity.modelId}`
	}
}
