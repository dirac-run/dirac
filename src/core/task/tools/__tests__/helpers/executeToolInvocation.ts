import type { ToolUse } from "@core/assistant-message"
import type { ToolExecutorCoordinator } from "../../ToolExecutorCoordinator"
import type { TaskConfig } from "../../types/TaskConfig"
import type { ToolResponse } from "../../types/ToolResponse"

/** Synchronous owner boundary for tool tests that exercise sequential turn effects. */
export async function executeToolInvocation(
	coordinator: ToolExecutorCoordinator,
	config: TaskConfig,
	block: ToolUse,
): Promise<ToolResponse> {
	const result = await coordinator.execute(config, block)
	if (result.effects.mistake === "increment") config.taskState.consecutiveMistakeCount++
	if (result.effects.mistake === "reset") config.taskState.consecutiveMistakeCount = 0
	if (result.effects.userInput) {
		config.taskState.pendingUserMessage = result.effects.userInput.message
		config.taskState.pendingUserImages = result.effects.userInput.images
		config.taskState.pendingUserFiles = result.effects.userInput.files
	}
	if (result.effects.context) config.taskState.userMessageContent.push(...result.effects.context)
	return result.content
}
