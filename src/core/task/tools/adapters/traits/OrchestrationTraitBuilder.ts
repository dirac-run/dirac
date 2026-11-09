import type { Hooks } from "@core/hooks/hook-factory"
import { activateTaskSkill } from "@core/task/activateTaskSkill"
import { getCurrentTurnUserRequests } from "@core/text-condensation/CurrentTurnUserRequests"
import type { DiracMessage } from "@shared/ExtensionMessage"
import type { IOrchestrationTrait } from "../../interfaces/IToolEnvironment"
import type { TaskConfig } from "../../types/TaskConfig"
// Builds the orchestration trait — tasklet supervision, hooks, mode switching, state management.
export function buildOrchestrationTrait(config: TaskConfig): IOrchestrationTrait {
	return {
		tasklets: config.executionProfile !== "tasklet" ? config.callbacks.tasklets : undefined,
		agentCommunication: config.callbacks.agentCommunication,
		agentWait: config.executionProfile === "tasklet" ? config.callbacks.agentWait : undefined,
		sharedJournal: config.callbacks.sharedJournal,
		runHook: async (name, input, options) => {
			const { executeHook } = await import("@core/hooks/hook-executor")
			return await executeHook({
				hookName: name as keyof Hooks,
				hookInput: input,
				messenger: config.taskMessenger,
				isCancellable: options?.isCancellable ?? false,
				setActiveHookExecution: config.callbacks.setActiveHookExecution,
				clearActiveHookExecution: config.callbacks.clearActiveHookExecution,
				messageStateHandler: config.messageState,
				taskId: config.taskId,
				hooksEnabled: config.hooksEnabled,
				model: { provider: config.providerId as any, slug: config.model.id || "unknown" },
			})
		},
		switchToActMode: () => config.callbacks.switchToActMode(),
		saveCheckpoint: (isTaskComplete, messageTs) => config.callbacks.saveCheckpoint(isTaskComplete, messageTs),
		commitAttemptCompletion: (response) => config.callbacks.commitAttemptCompletion(response),
		getHistory: () => config.messageState.getDiracMessages(),
		getCurrentTurnUserRequests: () => getCurrentTurnUserRequests(config.messageState.getDiracMessages()),
		setTruncationRange: (range) => {
			config.taskState.conversationHistoryDeletedRange = range
		},
		getNextTruncationRange: (strategy) =>
			config.services.contextManager.getNextTruncationRange(
				config.messageState.getApiConversationHistory(),
				config.taskState.conversationHistoryDeletedRange,
				strategy,
			),
		getTaskState: (key) => config.taskState[key],
		setTaskState: (key, value) => {
			config.taskState[key] = value
		},
		commitCompletionResponse: (response) => config.taskState.commitCompletionResponse(response),
		activateSkill: (skillId) => activateTaskSkill(config.storageAddress ?? config.taskId, config.taskState, skillId),
		doesLatestTaskCompletionHaveNewChanges: () => config.callbacks.doesLatestTaskCompletionHaveNewChanges(),
		updateMessage: (index, updates) => config.callbacks.updateDiracMessage(index, updates as Partial<DiracMessage>),
		resetTransientState: () => config.callbacks.resetTransientState(),
		notifyContextCompacted: () => config.callbacks.notifyContextCompacted(),
	}
}
