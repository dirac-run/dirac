import type { Hooks } from "@core/hooks/hook-factory"
import { getHookModelContext } from "@core/hooks/hook-model-context"
import { updateTaskMetadata } from "@core/storage/disk"
import type { DiracMessage } from "@shared/ExtensionMessage"
import type { IOrchestrationTrait } from "../../interfaces/IToolEnvironment"
import { SubagentRunner } from "../../subagent/SubagentRunner"
import type { TaskConfig } from "../../types/TaskConfig"
// Builds the orchestration trait — subagent execution, hooks, mode switching, state management.
export function buildOrchestrationTrait(config: TaskConfig): IOrchestrationTrait {
	return {
		runSubagent: async (prompt, options) => {
			const runner = new SubagentRunner(config, options?.subagentName, {
				allowedTools: options?.allowedTools,
				systemSuffix: options?.systemSuffix,
			})
			return await runner.run(
				prompt,
				options?.onUpdate || (() => { }),
				options?.timeout,
				options?.maxTurns,
				options?.includeHistory,
			)
		},
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
				hooksEnabled: config.services.stateManager.getGlobalSettingsKey("hooksEnabled") ?? false,
				model: getHookModelContext(config.api, config.services.stateManager),
			})
		},
		switchToActMode: () => config.callbacks.switchToActMode(),
		saveCheckpoint: (isTaskComplete, messageTs) => config.callbacks.saveCheckpoint(isTaskComplete, messageTs),
		getHistory: () => config.messageState.getDiracMessages(),
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
		activateSkill: async (skillId) => {
			const metadata = await updateTaskMetadata(config.taskId, (current) => {
				current.active_skill_ids = [...new Set([...(current.active_skill_ids ?? []), skillId])]
			})
			config.taskState.activeSkillIds = metadata.active_skill_ids ?? []
		},
		doesLatestTaskCompletionHaveNewChanges: () => config.callbacks.doesLatestTaskCompletionHaveNewChanges(),
		updateMessage: (index, updates) => config.callbacks.updateDiracMessage(index, updates as Partial<DiracMessage>),
		resetTransientState: () => config.callbacks.resetTransientState(),
	}
}
