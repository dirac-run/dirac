import type { Hooks } from "@core/hooks/hook-factory"
import { activateTaskSkill } from "@core/task/activateTaskSkill"
import { getConfiguredUtilityModelSelection } from "@core/utility-model/UtilityModelSelection"
import type { DiracMessage } from "@shared/ExtensionMessage"
import { Logger } from "@shared/services/Logger"
import type { IOrchestrationTrait } from "../../interfaces/IToolEnvironment"
import { SubagentRunner } from "../../subagent/SubagentRunner"
import { SubagentRunRecorder } from "../../subagent/SubagentRunRecorder"
import type { TaskConfig } from "../../types/TaskConfig"
import { SubagentUsagePublisher } from "./SubagentUsagePublisher"
// Builds the orchestration trait — subagent execution, hooks, mode switching, state management.
export function buildOrchestrationTrait(config: TaskConfig): IOrchestrationTrait {
	return {
		runSubagent: async (prompt, options) => {
			const agentIdentity = options?.agentIdentity ?? { id: 1, name: options?.subagentName ?? "subagent" }
			const utilityModelSelection = options?.useUtilityModel
				? getConfiguredUtilityModelSelection(config.utilityModelSelection)
				: undefined
			if (options?.useUtilityModel && !utilityModelSelection) {
				throw new Error("Utility model is not configured.")
			}
			const providerId = utilityModelSelection?.provider ?? config.providerId
			let recorder: SubagentRunRecorder | undefined
			try {
				recorder = await SubagentRunRecorder.create({
					taskId: config.taskId,
					agent: agentIdentity,
					taskTitle: options?.taskTitle ?? "Subagent task",
					prompt,
					timeoutSeconds: options?.timeout ?? 600,
					includeHistory: options?.includeHistory === true,
					providerId,
					modelId: utilityModelSelection?.modelId ?? config.model.id,
				})
			} catch (error) {
				Logger.error("[OrchestrationTraitBuilder] failed to initialize subagent recorder", error)
			}
			const runner = new SubagentRunner(config, options?.subagentName, {
				allowedTools: options?.allowedTools,
				utilityModelSelection,
				systemSuffix: options?.systemSuffix,
				agentIdentity,
				recorder,
			})
			const usage = new SubagentUsagePublisher(config.messageState, config.callbacks.postStateToWebview, agentIdentity.name)
			const result = await runner.run(prompt, async (update) => {
				if (update.stats) await usage.update(update.stats)
				await options?.onUpdate?.(update)
			}, options?.timeout, options?.includeHistory)
			await usage.finish(result.stats)
			return result
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
				hooksEnabled: config.hooksEnabled,
				model: { provider: config.providerId as any, slug: config.model.id || "unknown" },
			})
		},
		switchToActMode: () => config.callbacks.switchToActMode(),
		saveCheckpoint: (isTaskComplete, messageTs) => config.callbacks.saveCheckpoint(isTaskComplete, messageTs),
		commitAttemptCompletion: (response) => config.callbacks.commitAttemptCompletion(response),
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
		requestTaskReplacement: (context, images, files) => {
			config.taskState.pendingTaskReplacement = { context, images, files }
			config.taskState.abort = true
		},
		activateSkill: (skillId) => activateTaskSkill(config.taskId, config.taskState, skillId),
		doesLatestTaskCompletionHaveNewChanges: () => config.callbacks.doesLatestTaskCompletionHaveNewChanges(),
		updateMessage: (index, updates) => config.callbacks.updateDiracMessage(index, updates as Partial<DiracMessage>),
		resetTransientState: () => config.callbacks.resetTransientState(),
		notifyContextCompacted: () => config.callbacks.notifyContextCompacted(),
	}
}
