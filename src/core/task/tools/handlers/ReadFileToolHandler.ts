import path from "node:path"
import fs from "node:fs/promises"
import type { ToolUse } from "@core/assistant-message"
import { formatResponse } from "@core/prompts/responses"
import { resolveWorkspacePath } from "@core/workspace"
import { extractFileContent } from "@integrations/misc/extract-file-content"
import { contentHash, hashLines, stripHashes } from "@utils/line-hashing"
import { arePathsEqual, getReadablePath, isLocatedInWorkspace } from "@utils/path"
import { telemetryService } from "@/services/telemetry"
import { DiracSayTool } from "@/shared/ExtensionMessage"
import { DiracAssistantToolUseBlock, DiracStorageMessage, DiracUserToolResultContentBlock } from "@/shared/messages"
import { DiracDefaultTool } from "@/shared/tools"
import type { ToolResponse } from "../../index"
import { showNotificationForApproval } from "../../utils"
import type { IFullyManagedTool } from "../ToolExecutorCoordinator"
import type { ToolValidator } from "../ToolValidator"
import type { TaskConfig } from "../types/TaskConfig"
import type { StronglyTypedUIHelpers } from "../types/UIHelpers"
import { ToolResultUtils } from "../utils/ToolResultUtils"

export class ReadFileToolHandler implements IFullyManagedTool {
	readonly name = DiracDefaultTool.FILE_READ

	constructor(private validator: ToolValidator) {}

	getDescription(block: ToolUse): string {
		const relPaths = (block.params.paths as string[]) || (block.params.path ? [block.params.path as string] : [])
		const range =
			block.params.start_line || block.params.end_line
				? ` lines ${block.params.start_line || 1}-${block.params.end_line || "?"}`
				: ""
		return `[${block.name} for ${relPaths.map((p) => `'${p}'`).join(", ")}${range}]`
	}

	async handlePartialBlock(block: ToolUse, uiHelpers: StronglyTypedUIHelpers): Promise<void> {
		const relPaths = (block.params.paths as string[]) || (block.params.path ? [block.params.path as string] : [])
		const config = uiHelpers.getConfig()
		if (config.isSubagentExecution) {
			return
		}

		// Create and show partial UI message
		const sharedMessageProps = {
			tool: "readFile",
			paths: relPaths.map((p) => getReadablePath(config.cwd, uiHelpers.removeClosingTag(block, "paths", p))),
			content: undefined,
			operationIsLocatedInWorkspace: (await Promise.all(relPaths.map((p) => isLocatedInWorkspace(p)))).every(Boolean),
			startLine: uiHelpers.removeClosingTag(block, "start_line", block.params.start_line),
			endLine: uiHelpers.removeClosingTag(block, "end_line", block.params.end_line),
			readFileResults: relPaths.map((p) => ({
				path: getReadablePath(config.cwd, uiHelpers.removeClosingTag(block, "paths", p)),
				status: "success" as const,
				label: "Reading...",
			})),
		}
		const partialMessage = JSON.stringify(sharedMessageProps)

		// Handle auto-approval vs manual approval for partial
		const firstPath = relPaths[0] || ""
		if (await uiHelpers.shouldAutoApproveToolWithPath(block.name, firstPath)) {
			await uiHelpers.removeLastPartialMessageIfExistsWithType("ask", "tool")
			await uiHelpers.say("tool", partialMessage, undefined, undefined, block.partial)
		} else {
			await uiHelpers.removeLastPartialMessageIfExistsWithType("say", "tool")
			await uiHelpers.ask("tool", partialMessage, block.partial).catch(() => {})
		}
	}

	private extractLastKnownHashFromHistory(history: DiracStorageMessage[], targetPath: string): string | undefined {
		// Iterate backwards to find the most recent read_file for this exact path
		for (let i = history.length - 1; i >= 0; i--) {
			const message = history[i]

			// Find assistant messages containing tool calls
			if (message.role === "assistant" && Array.isArray(message.content)) {
				for (const block of message.content) {
					if (block.type === "tool_use") {
						const toolUseBlock = block as unknown as DiracAssistantToolUseBlock
						const input = toolUseBlock.input as any
						const hasPathMatch =
							input?.path === targetPath || (Array.isArray(input?.paths) && input.paths.includes(targetPath))
						if (toolUseBlock.name === this.name && hasPathMatch) {
							const toolUseId = toolUseBlock.id

							// The tool_result is almost always in the immediately following 'user' message
							const nextMessage = history[i + 1]
							if (nextMessage && nextMessage.role === "user" && Array.isArray(nextMessage.content)) {
								const resultBlock = nextMessage.content.find(
									(c) =>
										c.type === "tool_result" &&
										(c as unknown as DiracUserToolResultContentBlock).tool_use_id === toolUseId,
								)

								if (resultBlock && resultBlock.type === "tool_result") {
									// Extract text content from the result block
									const text =
										typeof resultBlock.content === "string"
											? resultBlock.content
											: Array.isArray(resultBlock.content)
												? (resultBlock.content.find((c: any) => c.type === "text") as any)?.text
												: undefined

									if (text) {
										// Match the exact hash string we output, considering potentially multiple files
										// If it's a multi-file read, we need to find the specific section for this path
										let sectionText = text
										if (text.includes(`--- ${targetPath} ---`)) {
											const parts = text.split(`--- ${targetPath} ---`)
											if (parts.length > 1) {
												sectionText = parts[1].split("\n--- ")[0]
											}
										}

										const match = sectionText.match(/\[File Hash: ([a-f0-9]+)\]/)
										if (match) {
											return match[1]
										}
									}
								}
							}
						}
					}
				}
			}
		}
		return undefined
	}

	async execute(config: TaskConfig, block: ToolUse): Promise<ToolResponse> {
		const relPaths = (block.params.paths as string[]) || (block.params.path ? [block.params.path as string] : [])
		const startLineNum = block.params.start_line ? Number.parseInt(String(block.params.start_line)) : undefined
		const endLineNum = block.params.end_line ? Number.parseInt(String(block.params.end_line)) : undefined

		if ((block.params.start_line && isNaN(startLineNum!)) || (block.params.end_line && isNaN(endLineNum!))) {
			config.taskState.consecutiveMistakeCount++
			const error = "Invalid line numbers. Please provide valid integers for start_line and end_line."

			// Ensure UI is updated to mark the tool call as complete (avoiding "stuck" state)
			const sharedMessageProps = {
				tool: "readFile",
				paths: relPaths.map((p) => getReadablePath(config.cwd, p)),
				content: error,
				operationIsLocatedInWorkspace: true,
				path: relPaths[0],
				startLine: block.params.start_line?.toString(),
				endLine: block.params.end_line?.toString(),
				readFileResults: relPaths.map((p) => ({
					path: getReadablePath(config.cwd, p),
					status: "error" as const,
					label: "Invalid line numbers",
				})),
			} satisfies DiracSayTool
			const completeMessage = JSON.stringify(sharedMessageProps)

			await config.callbacks.removeLastPartialMessageIfExistsWithType("ask", "tool")
			await config.callbacks.removeLastPartialMessageIfExistsWithType("say", "tool")
			await config.callbacks.say("tool", completeMessage, undefined, undefined, false)

			return formatResponse.toolError(error)
		}

		// Ensure apiConversationHistory is passed into TaskConfig from the main Dirac instance
		const history = config.messageState.getApiConversationHistory() || []

		// Extract provider information for telemetry
		const apiConfig = config.services.stateManager.getApiConfiguration()
		const currentMode = config.services.stateManager.getGlobalSettingsKey("mode")
		const provider = (currentMode === "plan" ? apiConfig.planModeApiProvider : apiConfig.actModeApiProvider) as string

		// Validate required parameters
		const pathValidation = block.params.paths
			? this.validator.assertRequiredParams(block, "paths")
			: this.validator.assertRequiredParams(block, "path")

		if (!pathValidation.ok) {
			config.taskState.consecutiveMistakeCount++
			return await config.callbacks.sayAndCreateMissingParamError(this.name, block.params.paths ? "paths" : "path")
		}

		const absolutePaths: string[] = []
		const displayPaths: string[] = []
		const workspaceContexts: any[] = []
		const results: string[] = []
		const readFileResults: any[] = []

		const imageBlocks: any[] = []
		let anyFailed = false
		let anySucceeded = false

		const supportsImages = config.api.getModel().info.supportsImages ?? false

		for (let i = 0; i < relPaths.length; i++) {
			const relPath = relPaths[i]
			const header = relPaths.length > 1 ? `--- ${relPath} ---\n` : ""

			try {
				// 1. Check diracignore access
				const accessValidation = this.validator.checkDiracIgnorePath(relPath)
				if (!accessValidation.ok) {
					if (!config.isSubagentExecution) {
						await config.callbacks.say("diracignore_error", relPath)
					}
					results.push(`${header}${formatResponse.diracIgnoreError(relPath)}`)
					readFileResults.push({
						path: relPath,
						status: "error",
						label: "Diracignore prevented file read",
					})
					anyFailed = true

					// Fill telemetry/UI fallbacks
					absolutePaths.push("")
					displayPaths.push(relPath)
					workspaceContexts.push({
						isMultiRootEnabled: !!config.isMultiRootEnabled,
						resolutionMethod: "ignored",
					})
					continue
				}

				// 2. Resolve the absolute path
				const pathResult = resolveWorkspacePath(config, relPath, "ReadFileToolHandler.execute")
				const { absolutePath, displayPath } =
					typeof pathResult === "string" ? { absolutePath: pathResult, displayPath: relPath } : pathResult

				absolutePaths.push(absolutePath)
				displayPaths.push(displayPath)

				// Determine workspace context for telemetry
				const fallbackAbsolutePath = path.resolve(config.cwd, relPath)
				workspaceContexts.push({
					isMultiRootEnabled: config.isMultiRootEnabled || false,
					usedWorkspaceHint: typeof pathResult !== "string",
					resolvedToNonPrimary: !arePathsEqual(absolutePath, fallbackAbsolutePath),
					resolutionMethod: (typeof pathResult !== "string" ? "hint" : "primary_fallback") as
						| "hint"
						| "primary_fallback",
				})

				// 3. Safety check: prevent reading files larger than 30KB without line range
				if (!startLineNum && !endLineNum) {
					const stats = await fs.stat(absolutePath)
					const ext = path.extname(absolutePath).toLowerCase()
					const isImage = [".png", ".jpg", ".jpeg", ".webp"].includes(ext)
					if (stats.isFile() && !isImage && stats.size > 30 * 1024) {
						results.push(
							`${header}The file size is ${Math.round(
								stats.size / 1024,
							)}KB, which exceeds the 30KB limit for full file reads. Reading this file will likely flood the context window. Please use more surgical means or specify a line range using 'start_line' and 'end_line' parameters.`,
						)
						readFileResults.push({
							path: displayPath,
							status: "error",
							label: "File too large (> 30KB)",
						})
						anyFailed = true
						continue
					}
				}

				// 4. Execute the file read operation
				const providedHash = this.extractLastKnownHashFromHistory(history, relPath)
				const fileContent = await extractFileContent(absolutePath, supportsImages)

				// Track file read operation
				await config.services.fileContextTracker.trackFileContext(relPath, "read_tool")
				anySucceeded = true

				// Store image blocks to push after potential approval
				if (fileContent.imageBlock) {
					imageBlocks.push(fileContent.imageBlock)
				}

				const currentHash = contentHash(fileContent.text)

				if (providedHash === currentHash && !startLineNum && !endLineNum) {
					results.push(`${header}no changes have been made to the file since your last read (Hash: ${providedHash})`)
				} else {
					let hashedContent = hashLines(fileContent.text, absolutePath, config.ulid)
					if (startLineNum || endLineNum) {
						const lines = hashedContent.split("\n")
						const start = Math.max(0, (startLineNum || 1) - 1)
						const end = Math.min(lines.length, endLineNum || lines.length)
						hashedContent = lines.slice(start, end).join("\n")
					}
					results.push(`${header}[File Hash: ${currentHash}]\n${hashedContent}`)
				}

				const range =
					startLineNum || endLineNum
						? `lines ${startLineNum || 1} to ${endLineNum || "end"}`
						: "full file"
				readFileResults.push({
					path: displayPath,
					status: "success",
					label: `Read ${range}`,
				})
			} catch (error) {
				anyFailed = true
				const errorMessage = error instanceof Error ? error.message : String(error)
				const normalizedMessage = errorMessage.startsWith("Error reading file:")
					? errorMessage
					: `Error reading file: ${errorMessage}`
				results.push(`${header}${normalizedMessage}`)

				// Ensure arrays are filled for telemetry/UI if they haven't been yet
				if (absolutePaths.length <= i) absolutePaths.push("")
				if (displayPaths.length <= i) displayPaths.push(relPath)
				if (workspaceContexts.length <= i)
					workspaceContexts.push({ isMultiRootEnabled: !!config.isMultiRootEnabled, resolutionMethod: "error" })

				readFileResults.push({
					path: displayPaths[i] || relPath,
					status: "error",
					label: normalizedMessage,
				})
			}
		}

		if (anyFailed) {
			config.taskState.consecutiveMistakeCount++
		} else if (anySucceeded) {
			config.taskState.consecutiveMistakeCount = 0
		}

		const finalResult = results.join("\n\n")

		// Handle approval flow
		const sharedMessageProps = {
			tool: "readFile",
			paths: displayPaths.map((p) => getReadablePath(config.cwd, p)),
			content: stripHashes(finalResult),
			operationIsLocatedInWorkspace: (await Promise.all(relPaths.map((p) => isLocatedInWorkspace(p)))).every(Boolean),
			path: displayPaths[0],
			startLine: startLineNum?.toString(),
			endLine: endLineNum?.toString(),
			readFileResults: readFileResults.map((r) => ({
				...r,
				path: getReadablePath(config.cwd, r.path),
			})),
		} satisfies DiracSayTool

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

			// Capture telemetry for each path
			for (let i = 0; i < relPaths.length; i++) {
				telemetryService.captureToolUsage(
					config.ulid,
					block.name,
					config.api.getModel().id,
					provider,
					true,
					true,
					workspaceContexts[i],
					block.isNativeToolCall,
				)
			}
		} else {
			// Manual approval flow
			const range = startLineNum || endLineNum ? ` lines ${startLineNum || 1}-${endLineNum || "?"}` : ""
			const notificationMessage = `Dirac wants to read ${relPaths.length} file(s)${range}`
			showNotificationForApproval(notificationMessage, config.autoApprovalSettings.enableNotifications)

			await config.callbacks.removeLastPartialMessageIfExistsWithType("say", "tool")

			const { didApprove } = await ToolResultUtils.askApprovalAndPushFeedback("tool", completeMessage, config)
			if (!didApprove) {
				for (let i = 0; i < relPaths.length; i++) {
					telemetryService.captureToolUsage(
						config.ulid,
						block.name,
						config.api.getModel().id,
						provider,
						false,
						false,
						workspaceContexts[i],
						block.isNativeToolCall,
					)
				}
				return formatResponse.toolDenied()
			}

			for (let i = 0; i < relPaths.length; i++) {
				telemetryService.captureToolUsage(
					config.ulid,
					block.name,
					config.api.getModel().id,
					provider,
					false,
					true,
					workspaceContexts[i],
					block.isNativeToolCall,
				)
			}
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

		// Push image blocks to task state after approval
		for (const imageBlock of imageBlocks) {
			config.taskState.userMessageContent.push(imageBlock)
		}

		return finalResult
	}
}
