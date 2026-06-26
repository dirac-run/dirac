import type { ToolUse } from "@core/assistant-message"
import { DiracDefaultTool } from "@/shared/tools"
import { CardStatus } from "../../../shared/ExtensionMessage"
import { SurfaceAdapter } from "./adapters/SurfaceAdapter"

import { DiracContext } from "./context/DiracContext"
import { IDiracTool } from "./interfaces/IDiracTool"
import { SurfaceType } from "./interfaces/SurfaceType"
import { AgentConfigLoader } from "./subagent/AgentConfigLoader"
import type { TaskConfig } from "./types/TaskConfig"
import type { ToolResponse } from "./types/ToolResponse"
import { ToolSkippedByUserMessage } from "./types/ToolSkippedByUserMessage"
import { createUIHelpers } from "./types/UIHelpers"

interface PartialToolUseHandler extends IDiracTool {
	bufferPartialToolUse(block: ToolUse, uiHelpers: ReturnType<typeof createUIHelpers>): Promise<void>
}

/**
 * Coordinates tool execution by routing to registered handlers.
 * Throws an error for unregistered tools.
 */
export class ToolExecutorCoordinator {
	constructor() {}

	private modularTools = new Map<string, IDiracTool>()

	async bufferPartialToolUse(block: ToolUse, config: TaskConfig): Promise<void> {
		const modularTool = this.modularTools.get(block.name)
		if (modularTool && "bufferPartialToolUse" in modularTool) {
			const uiHelpers = createUIHelpers(config)
			await (modularTool as PartialToolUseHandler).bufferPartialToolUse(block, uiHelpers)
		}
	}

	registerModularTool(tool: IDiracTool): void {
		const spec = tool.spec()
		const name = spec.name
		if (name) {
			this.modularTools.set(name, tool)
		}
	}

	has(toolName: string): boolean {
		if (this.modularTools.has(toolName)) {
			return true
		}

		return (
			AgentConfigLoader.getInstance().isDynamicSubagentTool(toolName) &&
			this.modularTools.has(DiracDefaultTool.USE_SUBAGENTS)
		)
	}

	async execute(config: TaskConfig, block: ToolUse): Promise<ToolResponse> {
		const modularTool = this.modularTools.get(block.name)

		if (!modularTool && AgentConfigLoader.getInstance().isDynamicSubagentTool(block.name)) {
			const subagentTool = this.modularTools.get(DiracDefaultTool.USE_SUBAGENTS)
			if (subagentTool) {
				return this.executeModularTool(subagentTool, config, block)
			}
		}

		if (modularTool) {
			return this.executeModularTool(modularTool, config, block)
		}

		throw new Error(`No modular tool registered for: ${block.name}`)
	}

	private async executeModularTool(tool: IDiracTool, config: TaskConfig, block: ToolUse): Promise<ToolResponse> {
		const startTime = Date.now()

		// 1. Initialize Tool Environment (Surface Adapter)
		const env = new SurfaceAdapter(config, block.name)

		// 2. Load Context
		await (env.context as DiracContext).load()

		// 3. Filter (Surface Check)
		const supported = tool.supportedSurfaces()
		const currentSurface: SurfaceType = config.vscodeTerminalExecutionMode === "vscodeTerminal" ? "ide" : "cli"

		if (supported.length > 0 && !supported.includes("all") && !supported.includes(currentSurface)) {
			const error = new Error(`Surface mismatch: ${currentSurface}`)
			return `Tool '${block.name}' is not supported on the current surface (${currentSurface}).`
		}

		// 4. Pre-tool Hooks
		try {
			const { ToolHookUtils } = await import("./utils/ToolHookUtils")
			await ToolHookUtils.runPreToolUseIfEnabled(config, block)
		} catch (error: any) {
			const { PreToolUseHookCancellationError } = await import("@core/hooks/PreToolUseHookCancellationError")
			if (error instanceof PreToolUseHookCancellationError) {
				return `Cancelled by pre-tool hook: ${error.message}`
			}
			throw error
		}

		// 5. Observability: "Calling..." (Removed redundant message)

		let executionSuccess = false
		let result: any

		const initialMistakeCount = config.taskState.consecutiveMistakeCount
		const unfinalizedCards: { id: string; status: CardStatus }[] = []
		try {
			// 6. Execute (Dispatcher)
			result = await tool.processCall(block.params, env)
			executionSuccess = true

			// 7. Persist Context
			await (env.context as DiracContext).save()

			// 8. Observability: "Finished..." (Removed redundant message)

			// 9. Update Mistake Count (Success)
			config.taskState.consecutiveMistakeCount =
				config.taskState.consecutiveMistakeCount > initialMistakeCount ? initialMistakeCount + 1 : 0

			// 10. Return Result
			return result
		} catch (error: any) {
			executionSuccess = false

			// Handle user text-based tool skip
			if (error instanceof ToolSkippedByUserMessage) {
				executionSuccess = false // Tool did not execute; distinguished via customMetadata.skippedByUser

				// Don't increment mistake count - this is intentional user action
				config.taskState.consecutiveMistakeCount = initialMistakeCount

				// Store the user's message for forwarding to the LLM
				config.taskState.pendingUserMessage = error.userMessage
				config.taskState.pendingUserImages = error.userImages
				config.taskState.pendingUserFiles = error.userFiles

				// Finalize all cards as SKIPPED immediately
				for (const card of env.getCreatedCards()) {
					const finalStates: CardStatus[] = [
						CardStatus.SUCCESS,
						CardStatus.ERROR,
						CardStatus.SKIPPED,
						CardStatus.ABANDONED,
						CardStatus.CANCELLED,
					]
					if (!finalStates.includes(card.status)) {
						await card.finalize(CardStatus.SKIPPED)
					}
				}

				env.telemetry.captureCustomMetadata({ skippedByUser: true, userMessageLength: error.userMessage.length })
				return `[Tool '${block.name}' skipped by user with message: "${error.userMessage}"]`
			}

			// 11. Update Mistake Count (Failure)
			config.taskState.consecutiveMistakeCount = initialMistakeCount + 1

			return `Execution failed: ${error.message || error}`
		} finally {
			// 12. Telemetry
			const duration = Date.now() - startTime
			const customMetadata = env.getCustomMetadata()

			const { telemetryService } = await import("@/services/telemetry")
			const { getProviderForModel } = await import("@shared/api")

			const modelId = config.api.getModel().id
			const providerId = getProviderForModel(modelId) || "unknown"

			telemetryService.captureToolUsage(
				config.ulid,
				block.name,
				modelId,
				providerId,
				false, // didAutoApprove
				executionSuccess,
				{
					...customMetadata,
					durationMs: duration,
					modular: true,
				},
				block.isNativeToolCall,
			)

			// 13. Collect unfinalized cards — assert after finally to avoid unsafe throw
			const finalStates: CardStatus[] = [
				CardStatus.SUCCESS,
				CardStatus.ERROR,
				CardStatus.SKIPPED,
				CardStatus.ABANDONED,
				CardStatus.CANCELLED,
			]
			for (const card of env.getCreatedCards()) {
				if (!finalStates.includes(card.status) && card.cleanupStrategy !== "keep_running") {
					unfinalizedCards.push({ id: card.id, status: card.status })
				}
			}
		}

		// Assert tools finalized their own cards — no defensive finalization
		if (unfinalizedCards.length > 0) {
			throw new Error(
				`Tool '${block.name}' did not finalize card(s): ${unfinalizedCards.map((c) => `${c.id} (${c.status})`).join(", ")}`,
			)
		}
	}
}
