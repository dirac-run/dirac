import path from "node:path"
import type { ToolUse } from "@core/assistant-message"
import { formatResponse } from "@core/prompts/responses"
import { getWorkspaceBasename, resolveWorkspacePath } from "@core/workspace"
import { listFiles } from "@services/glob/list-files"
import { arePathsEqual, getReadablePath, isLocatedInWorkspace } from "@utils/path"
import { telemetryService } from "@/services/telemetry"
import { DiracDefaultTool } from "@/shared/tools"
import type { ToolResponse } from "../../index"
import { showNotificationForApproval } from "../../utils"
import type { IFullyManagedTool } from "../ToolExecutorCoordinator"
import type { ToolValidator } from "../ToolValidator"
import type { TaskConfig } from "../types/TaskConfig"
import type { StronglyTypedUIHelpers } from "../types/UIHelpers"
import { ToolResultUtils } from "../utils/ToolResultUtils"

export class ListFilesToolHandler implements IFullyManagedTool {
	private static readonly MAX_FILES_LIMIT = 200
	readonly name = DiracDefaultTool.LIST_FILES

	constructor(private validator: ToolValidator) {}

		getDescription(block: ToolUse): string {
		const relPaths = Array.isArray(block.params.paths) ? block.params.paths : (block.params.paths ? [block.params.paths as string] : [])
		return `[${block.name} for ${relPaths.map((p) => `'${p}'`).join(", ")}]`
	}

		async handlePartialBlock(block: ToolUse, uiHelpers: StronglyTypedUIHelpers): Promise<void> {
		const relPaths = Array.isArray(block.params.paths) ? block.params.paths : (block.params.paths ? [block.params.paths as string] : [])

		// Get config access for services
		const config = uiHelpers.getConfig()
		if (config.isSubagentExecution) {
			return
		}

		// Create and show partial UI message
		const recursiveRaw = block.params.recursive
		const recursive = String(recursiveRaw ?? "").toLowerCase() === "true"
		const sharedMessageProps = {
			tool: recursive ? "listFilesRecursive" : "listFilesTopLevel",
			paths: relPaths.map((p) => getReadablePath(config.cwd, uiHelpers.removeClosingTag(block, "paths", p))),
			content: "",
			operationIsLocatedInWorkspace: (await Promise.all(relPaths.map((p) => isLocatedInWorkspace(p)))).every(Boolean),
		}

		const partialMessage = JSON.stringify(sharedMessageProps)

		// Handle auto-approval vs manual approval for partial
		const shouldAutoApprove =
			config.isSubagentExecution ||
			(await Promise.all(relPaths.map((p) => uiHelpers.shouldAutoApproveToolWithPath(block.name, p)))).every(Boolean)

		if (shouldAutoApprove) {
			await uiHelpers.removeLastPartialMessageIfExistsWithType("ask", "tool")
			await uiHelpers.say("tool", partialMessage, undefined, undefined, block.partial)
		} else {
			await uiHelpers.removeLastPartialMessageIfExistsWithType("say", "tool")
			await uiHelpers.ask("tool", partialMessage, block.partial).catch(() => {})
		}
	}

		async execute(config: TaskConfig, block: ToolUse): Promise<ToolResponse> {
		const relPaths = Array.isArray(block.params.paths) ? block.params.paths : (block.params.paths ? [block.params.paths as string] : [])
		const recursiveRaw = block.params.recursive
		const recursive = String(recursiveRaw ?? "").toLowerCase() === "true"

		// Extract provider using the proven pattern from ReportBugHandler
		const apiConfig = config.services.stateManager.getApiConfiguration()
		const currentMode = config.services.stateManager.getGlobalSettingsKey("mode")
		const provider = (currentMode === "plan" ? apiConfig.planModeApiProvider : apiConfig.actModeApiProvider) as string

		// Validate required parameters
		let validation: { ok: boolean; error?: string; paramName?: string }
		if (block.params.paths) {
			validation = { ...this.validator.assertRequiredParams(block, "paths"), paramName: "paths" }
		} else {
			validation = { ok: false, error: "Missing required parameter: 'paths' must be provided." }
		}

		if (!validation.ok) {
			config.taskState.consecutiveMistakeCount++
			if (validation.paramName) {
				return await config.callbacks.sayAndCreateMissingParamError(this.name, validation.paramName as any)
			} else {
				await config.callbacks.say(
					"error",
					`Dirac tried to use ${this.name} without providing any paths. Retrying...`
				)
				return formatResponse.toolError(validation.error!)
			}
		}

		const results: string[] = []
		const displayPaths: string[] = []
		const absolutePaths: string[] = []
		let hasError = false
		let totalFilesFound = 0
		let anyHitLimit = false
		let anyUsedWorkspaceHint = false
		let anyResolvedToNonPrimary = false

		for (const relDirPath of relPaths) {
			// Check diracignore access before performing any IO.
			const accessValidation = this.validator.checkDiracIgnorePath(relDirPath)
			if (!accessValidation.ok) {
				if (!config.isSubagentExecution) {
					await config.callbacks.say("diracignore_error", relDirPath)
				}
				results.push(`Access to ${relDirPath} is blocked by .diracignore settings.`)
				hasError = true
				continue
			}

			try {
				const pathResult = resolveWorkspacePath(config, relDirPath, "ListFilesToolHandler.execute")
				const { absolutePath, displayPath } =
					typeof pathResult === "string" ? { absolutePath: pathResult, displayPath: relDirPath } : pathResult
				
				const usedWorkspaceHint = typeof pathResult !== "string"
				const [fileInfos, didHitLimit] = await listFiles(absolutePath, recursive, ListFilesToolHandler.MAX_FILES_LIMIT)
				
				absolutePaths.push(absolutePath)
				displayPaths.push(displayPath)
				anyHitLimit = anyHitLimit || didHitLimit
				anyUsedWorkspaceHint = anyUsedWorkspaceHint || usedWorkspaceHint
				
				const fallbackAbsolutePath = path.resolve(config.cwd, relDirPath)
				if (!arePathsEqual(absolutePath, fallbackAbsolutePath)) {
					anyResolvedToNonPrimary = true
				}

				const formattedList = formatResponse.formatFilesList(
					absolutePath,
					fileInfos,
					didHitLimit,
					config.services.diracIgnoreController,
				)
				
				results.push(`Contents of ${relDirPath}:\n${formattedList}`)
				totalFilesFound += fileInfos.length
			} catch (error) {
				hasError = true
				const errorMessage = error instanceof Error ? error.message : String(error)
				results.push(`Error listing files in ${relDirPath}: ${errorMessage}`)
			}
		}

		if (hasError && results.length === relPaths.length && totalFilesFound === 0) {
			config.taskState.consecutiveMistakeCount++
		} else {
			config.taskState.consecutiveMistakeCount = 0
		}

		const finalResult = results.join("\n\n" + "=".repeat(20) + "\n\n")

		// Determine workspace context for telemetry
		const workspaceContext = {
			isMultiRootEnabled: config.isMultiRootEnabled || false,
			usedWorkspaceHint: anyUsedWorkspaceHint,
			resolvedToNonPrimary: anyResolvedToNonPrimary,
			resolutionMethod: (anyUsedWorkspaceHint ? "hint" : "primary_fallback") as "hint" | "primary_fallback",
		}

		// Handle approval flow
		const sharedMessageProps = {
			tool: recursive ? "listFilesRecursive" : "listFilesTopLevel",
			paths: displayPaths.map((p) => getReadablePath(config.cwd, p)),
			content: finalResult,
			operationIsLocatedInWorkspace: (await Promise.all(relPaths.map((p) => isLocatedInWorkspace(p)))).every(Boolean),
			path: displayPaths[0],
		}

		const completeMessage = JSON.stringify(sharedMessageProps)

		const shouldAutoApprove =
			config.isSubagentExecution ||
			(await Promise.all(relPaths.map((p) => config.callbacks.shouldAutoApproveToolWithPath(block.name, p)))).every(Boolean)

		if (shouldAutoApprove) {
			// Auto-approval flow
			if (!config.isSubagentExecution) {
				await config.callbacks.removeLastPartialMessageIfExistsWithType("ask", "tool")
				await config.callbacks.say("tool", completeMessage, undefined, undefined, false)
			}

			telemetryService.captureToolUsage(
				config.ulid,
				block.name,
				config.api.getModel().id,
				provider,
				true,
				true,
				workspaceContext,
				block.isNativeToolCall,
			)
		} else {
			// Manual approval flow
			const notificationMessage =
				relPaths.length > 1
					? `Dirac wants to view ${relPaths.length} directories`
					: `Dirac wants to view directory ${getWorkspaceBasename(absolutePaths[0], "ListFilesToolHandler.notification")}/`

			showNotificationForApproval(notificationMessage, config.autoApprovalSettings.enableNotifications)

			await config.callbacks.removeLastPartialMessageIfExistsWithType("say", "tool")
			await config.callbacks.removeLastPartialMessageIfExistsWithType("ask", "tool")

			const { didApprove } = await ToolResultUtils.askApprovalAndPushFeedback("tool", completeMessage, config)
			if (!didApprove) {
				telemetryService.captureToolUsage(
					config.ulid,
					block.name,
					config.api.getModel().id,
					provider,
					false,
					false,
					workspaceContext,
					block.isNativeToolCall,
				)
				return formatResponse.toolDenied()
			}
			telemetryService.captureToolUsage(
				config.ulid,
				block.name,
				config.api.getModel().id,
				provider,
				false,
				true,
				workspaceContext,
				block.isNativeToolCall,
			)
		}

		// Run PreToolUse hook after approval but before execution
		try {
			const { ToolHookUtils } = await import("../utils/ToolHookUtils")
			await ToolHookUtils.runPreToolUseIfEnabled(config, block)
		} catch (error) {
			const { PreToolUseHookCancellationError } = await import("@core/hooks/PreToolUseHookCancellationError")
			if (error instanceof PreToolUseHookCancellationError) {
				return formatResponse.toolDenied()
			}
			throw error
		}

		return finalResult
	}
}

