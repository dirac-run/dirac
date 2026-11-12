import type { ToolUse } from "@core/assistant-message"
import { HookCleanupError } from "@core/hooks/HookCleanupError"
import { CardStatus, isFinalStatus } from "../../../shared/ExtensionMessage"
import { SurfaceToolEnvironmentFactory } from "./adapters/SurfaceAdapter"
import type { ToolEnvironmentFactory } from "./interfaces/ToolEnvironmentFactory"
import type { ToolInvocationEffects, ToolInvocationEffectsAccumulator, ToolInvocationResult } from "./interfaces/ToolInvocationResult"

import { IDiracTool } from "./interfaces/IDiracTool"
import { SurfaceType } from "./interfaces/SurfaceType"
import { assertValidToolResponse } from "./runtime/assertValidToolResponse"
import { normalizeOptionalToolParameters } from "./runtime/normalizeOptionalToolParameters"
import type { TaskConfig } from "./types/TaskConfig"
import type { ToolResponse } from "./types/ToolResponse"
import { ToolSkippedByUserMessage } from "./types/ToolSkippedByUserMessage"
import { createUIHelpers } from "./types/UIHelpers"
import { formatResponse } from "@core/formatResponse"
import { ToolTimeoutError } from "./runtime/ToolExecutionDeadline"

interface PartialToolUseHandler extends IDiracTool {
	bufferPartialToolUse(block: ToolUse, uiHelpers: ReturnType<typeof createUIHelpers>): Promise<void>
}

/**
 * Coordinates tool execution by routing to registered handlers.
 * Throws an error for unregistered tools.
 */
export class ToolExecutorCoordinator {
	constructor(private readonly environmentFactory: ToolEnvironmentFactory = new SurfaceToolEnvironmentFactory()) { }

	createEmptySibling(): ToolExecutorCoordinator {
		return new ToolExecutorCoordinator(this.environmentFactory)
	}

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
		return this.modularTools.has(toolName)
	}

	async execute(config: TaskConfig, block: ToolUse): Promise<ToolInvocationResult> {
		const modularTool = this.modularTools.get(block.name)
		if (!modularTool) throw new Error(`No modular tool registered for: ${block.name}`)
		return this.executeModularTool(modularTool, config, block)
	}

	private async executeModularTool(tool: IDiracTool, config: TaskConfig, block: ToolUse): Promise<ToolInvocationResult> {
		const startTime = Date.now()
		const requestSnapshot = config.activeToolSnapshot
		const nativeTool = requestSnapshot?.nativeTools.find(
			(candidate) => "function" in candidate && candidate.function.name === block.name,
		)
		if (requestSnapshot && nativeTool && "function" in nativeTool && nativeTool.function.strict === true) {
			const requestSpec = requestSnapshot.promptVisibleSpecs.find((spec) => spec.name === block.name) ?? tool.spec()
			block.params = normalizeOptionalToolParameters(block.params, requestSpec)
		}

		// 1. Initialize Tool Environment (Surface Adapter)
		// Preserve live task-setting accessors while adding call-specific metadata.
		const toolConfig = Object.create(Object.getPrototypeOf(config), Object.getOwnPropertyDescriptors(config)) as TaskConfig
		toolConfig.toolUse = { name: block.name, params: block.params }
		const initialMistakeCount = config.taskState.consecutiveMistakeCount
		const invocationEffects: ToolInvocationEffectsAccumulator = { consecutiveMistakeCount: initialMistakeCount }
		toolConfig.invocationEffects = invocationEffects
		const env = this.environmentFactory.create(toolConfig, block.name)
		const signal = env.orchestration.getTaskState("abortSignal")

		// 2. Filter (Surface Check)
		const supported = tool.supportedSurfaces()
		const currentSurface: SurfaceType = config.vscodeTerminalExecutionMode === "vscodeTerminal" ? "ide" : "cli"

		if (supported.length > 0 && !supported.includes("all") && !supported.includes(currentSurface)) {
			return {
				outcome: "failure",
				content: `Tool '${block.name}' is not supported on the current surface (${currentSurface}).`,
				effects: { mistake: "none" },
			}
		}

		// 3. Pre-tool Hooks
		try {
			const { ToolHookUtils } = await import("./utils/ToolHookUtils")
			await ToolHookUtils.runPreToolUseIfEnabled(toolConfig, block)
		} catch (error: any) {
			const { PreToolUseHookCancellationError } = await import("@core/hooks/PreToolUseHookCancellationError")
			if (error instanceof PreToolUseHookCancellationError) {
				return {
					outcome: "cancelled",
					preStartVeto: true,
					content: `Cancelled by pre-tool hook: ${error.message}`,
					effects: { mistake: "none", ...(invocationEffects.cancelTask ? { cancelTask: true } : {}) },
				}
			}
			throw error
		}

		// 4. Observability: "Calling..." (Removed redundant message)

		let executionSuccess = false
		let response!: ToolResponse
		let outcome: ToolInvocationResult["outcome"] = "success"
		let executionError: Error | undefined

		const effects: ToolInvocationEffects = { mistake: "none" }
		const unfinalizedCards: { id: string; status: CardStatus }[] = []
		try {
			// 5. Execute (Dispatcher)
			signal?.throwIfAborted()
			const result = await tool.processCall(block.params, env)
			assertValidToolResponse(result, block.name)

			// 6. Persist Context
			await env.context.save()

			// 7. Observability: "Finished..." (Removed redundant message)

			// 8. Return the mistake transition for the task owner to apply.
			effects.mistake = invocationEffects.consecutiveMistakeCount > initialMistakeCount
				? "increment" : invocationEffects.failed ? "none" : "reset"
			// Existing validation reporters use the mistake counter; operational failures can
			// report failure independently. Neither response text nor card status is authoritative.
			outcome = invocationEffects.failed || effects.mistake === "increment" ? "failure" : "success"
			executionSuccess = outcome === "success"

			// 9. Store Result
			response = result
		} catch (error: any) {
			executionSuccess = false
			if (error instanceof HookCleanupError) throw error

			if (signal?.aborted) {
				outcome = "cancelled"
				response = `Tool '${block.name}' cancelled: ${error instanceof Error ? error.message : String(error)}`
			} else if (error instanceof ToolSkippedByUserMessage) {
				outcome = "cancelled"
				if (!error.modeSwitch) {
					effects.userInput = { message: error.userMessage, images: error.userImages, files: error.userFiles }
				}

				for (const card of env.getCreatedCards()) {
					if (!isFinalStatus(card.status)) {
						await card.finalize(CardStatus.SKIPPED)
					}
				}

				env.telemetry.captureCustomMetadata({ skippedByUser: true, userMessageLength: error.userMessage.length })
				response = error.modeSwitch
					? formatResponse.toolResult(
						`[Interaction skipped. ${error.userMessage}]`,
						error.userImages,
						error.userFiles?.length ? await env.workspace.formatAttachedFiles(error.userFiles) : "",
					)
					: `[Tool '${block.name}' skipped by user with message: "${error.userMessage}"]`
			} else {
				executionError = error instanceof Error ? error : new Error(String(error))
				outcome = "failure"
				effects.mistake = "increment"
				if (executionError instanceof ToolTimeoutError) {
					env.telemetry.captureCustomMetadata({
						timedOut: true,
						timeoutMs: executionError.timeoutMs,
						timeoutOperation: executionError.operation,
					})
					response = formatResponse.toolTimeout(
						executionError.toolName,
						executionError.operation,
						executionError.timeoutMs,
					)
				} else {
					response = `Execution failed: ${error.message || error}`
				}
			}
		} finally {
			// 12. Telemetry
			const duration = Date.now() - startTime
			const customMetadata = env.getCustomMetadata()

			const { telemetryService } = await import("@/services/telemetry")

			const modelId = config.model.id
			const providerId = config.providerId

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
			for (const card of env.getCreatedCards()) {
				if (!isFinalStatus(card.status) && card.cleanupStrategy !== "keep_running") {
					unfinalizedCards.push({ id: card.id, status: card.status })
				}
			}
		}

		// Assert tools finalized their own cards — no defensive finalization
		if (unfinalizedCards.length > 0) {
			throw new Error(
				`Tool '${block.name}' left nonterminal card(s): ${unfinalizedCards.map((c) => `${c.id} (${c.status})`).join(", ")}${executionError ? `. Original execution error: ${executionError.message}` : ""}`,
			)
		}
		if (invocationEffects.context) effects.context = invocationEffects.context
		return { outcome, content: response, effects }
	}
}
