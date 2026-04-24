import type { ToolUse } from "@core/assistant-message"
import { formatResponse } from "@core/prompts/responses"
import { WorkspacePathAdapter } from "@core/workspace/WorkspacePathAdapter"
import { MultiCommandState } from "@shared/ExtensionMessage"
import { telemetryService } from "@/services/telemetry"
import { DiracDefaultTool } from "@/shared/tools"
import type { ToolResponse } from "../../index"
import { showNotificationForApproval } from "../../utils"
import type { IFullyManagedTool } from "../ToolExecutorCoordinator"
import type { ToolValidator } from "../ToolValidator"
import type { TaskConfig } from "../types/TaskConfig"
import type { StronglyTypedUIHelpers } from "../types/UIHelpers"
import { isSafeCommand } from "../utils/CommandSafetyChecker"
import { applyModelContentFixes } from "../utils/ModelContentProcessor"
import { truncateHeadTail } from "@/shared/content-limits"
import { ToolResultUtils } from "../utils/ToolResultUtils"

// Default timeout for commands in yolo mode and background exec mode
const DEFAULT_COMMAND_TIMEOUT_SECONDS = 30
const LONG_RUNNING_COMMAND_TIMEOUT_SECONDS = 300
const MAX_COMMAND_OUTPUT_SIZE = 10 * 1024 // 10KB limit to avoid context flooding, extra safety layer

const LONG_RUNNING_COMMAND_PATTERNS: RegExp[] = [
	/\b(npm|pnpm|yarn|bun)\s+(install|ci|build|test)\b/i,
	/\b(npm|pnpm|yarn|bun)\s+run\s+(build|test|lint|typecheck|check)\b/i,
	/\b(pip|pip3|uv)\s+install\b/i,
	/\b(poetry|pipenv)\s+install\b/i,
	/\b(cargo|go|mvn|gradle|gradlew)\s+(build|test|check|install)\b/i,
	/\b(make|cmake|ctest)\b/i,
	/\b(pytest|tox|nox|jest|vitest|mocha)\b/i,
	/\b(docker|podman)\s+build\b/i,
	/\b(torchrun|deepspeed|accelerate\s+launch)\b/i,
	/\b(sleep|wait|watch)\b/i,
	/\b(rails|rake|bundle\s+exec\s+rake)\s+db:(migrate|setup|seed)\b/i,
	/\b(alembic|flask\s+db)\s+(upgrade|downgrade)\b/i,
	/\b(prisma|npx\s+prisma)\s+(migrate|db\s+push)\b/i,
	/\b(sequelize|npx\s+sequelize)\s+db:migrate\b/i,
	/\b(django-admin|python\s+manage\.py)\s+migrate\b/i,
	/\bffmpeg\b/i,
	/\bpython(?:\d+(?:\.\d+)?)?\s+.*\b(train|finetune)\b/i,
]

export function isLikelyLongRunningCommand(command: string): boolean {
	const normalized = command.trim().replace(/\s+/g, " ")
	return LONG_RUNNING_COMMAND_PATTERNS.some((pattern) => pattern.test(normalized))
}

export function resolveCommandTimeoutSeconds(command: string, useManagedTimeout: boolean): number | undefined {
	if (!useManagedTimeout) {
		return undefined
	}

	return isLikelyLongRunningCommand(command) ? LONG_RUNNING_COMMAND_TIMEOUT_SECONDS : DEFAULT_COMMAND_TIMEOUT_SECONDS
}

export class ExecuteCommandToolHandler implements IFullyManagedTool {
	readonly name = DiracDefaultTool.BASH

	constructor(private validator: ToolValidator) {}

	getDescription(block: ToolUse): string {
		const commands = Array.isArray(block.params.commands) ? block.params.commands : (block.params.commands ? [block.params.commands as string] : [])
		const script = block.params.script as string | undefined
		const language = block.params.language as string | undefined

		if (script) {
			const langDisplay = language ? ` (${language})` : ""
			return `[${block.name} for script${langDisplay}]`
		}

		if (commands.length > 0) {
			return `[${block.name} for ${commands.length} commands]`
		}

		return `[${block.name} for '${commands[0] || ""}']`
	}

	async handlePartialBlock(block: ToolUse, uiHelpers: StronglyTypedUIHelpers): Promise<void> {
		const config = uiHelpers.getConfig()
		if (config.isSubagentExecution) {
			return
		}

		const rawCommands = (block.params.commands as any) || []
		const script = block.params.script as string | undefined
		const language = (block.params.language as string | undefined) || "bash"

		const commandsToProcess: { command: string; displayName?: string }[] = []
		if (Array.isArray(rawCommands)) {
			rawCommands.forEach((cmd: string) => {
				if (cmd) {
					commandsToProcess.push({
						command: uiHelpers.removeClosingTag(block, "commands", cmd),
					})
				}
			})
		} else if (typeof rawCommands === "string" && rawCommands.trim() !== "") {
			commandsToProcess.push({
				command: uiHelpers.removeClosingTag(block, "commands", rawCommands),
			})
		}

		if (script) {
			const langDisplay = language.charAt(0).toUpperCase() + language.slice(1)
			commandsToProcess.push({
				command: uiHelpers.removeClosingTag(block, "script", script),
				displayName: `${langDisplay} script`,
			})
		}

		if (commandsToProcess.length === 0) {
			return
		}

		const multiCommandState: MultiCommandState = {
			commands: commandsToProcess.map((item) => ({
				command: item.command,
				displayName: item.displayName,
				status: "pending",
			})),
		}

		// Determine if we should use 'ask' or 'say' based on auto-approval
		// For simplicity, we check the first command's safety
		const firstCommand = commandsToProcess[0].command
		const isSafe = isSafeCommand(firstCommand)
		const autoApproveResult = uiHelpers.shouldAutoApproveTool(this.name)
		const autoApproveEnabled = Array.isArray(autoApproveResult) ? autoApproveResult[0] : autoApproveResult
		const isYolo = config.yoloModeToggled || config.services.stateManager.getGlobalSettingsKey("autoApproveAllToggled")

		const shouldAutoApprove = isYolo || (isSafe && autoApproveEnabled)

		if (shouldAutoApprove) {
			await uiHelpers.removeLastPartialMessageIfExistsWithType("ask", "tool")
			await uiHelpers.say("tool", firstCommand, undefined, undefined, block.partial, multiCommandState)
		} else {
			await uiHelpers.removeLastPartialMessageIfExistsWithType("say", "tool")
			await uiHelpers.ask("tool", firstCommand, block.partial, multiCommandState).catch(() => {})
		}
	}

	async execute(config: TaskConfig, block: ToolUse): Promise<ToolResponse> {
		const rawCommands = (block.params.commands as any) || []
		const script = block.params.script as string | undefined
		const language = (block.params.language as string | undefined) || "bash"

		// Validate required parameters
		let validation: { ok: boolean; error?: string; paramName?: string }
		if (block.params.commands) {
			validation = { ...this.validator.assertRequiredParams(block, "commands"), paramName: "commands" }
		} else if (block.params.script) {
			validation = { ...this.validator.assertRequiredParams(block, "script"), paramName: "script" }
		} else {
			validation = { ok: false, error: "Missing required parameter: 'commands' or 'script' must be provided." }
		}

		if (!validation.ok) {
			config.taskState.consecutiveMistakeCount++
			if (validation.paramName) {
				return await config.callbacks.sayAndCreateMissingParamError(this.name, validation.paramName as any)
			} else {
				await config.callbacks.say(
					"error",
					`Dirac tried to use ${this.name} without providing any commands or script. Retrying...`
				)
				return formatResponse.toolError(validation.error!)
			}
		}

		// Normalize to a list of commands
		const commandsToProcess: { command: string; displayName?: string }[] = []

		if (Array.isArray(rawCommands) && rawCommands.length > 0) {
			rawCommands.forEach((cmd: string) => commandsToProcess.push({ command: cmd }))
		} else if (typeof rawCommands === "string" && rawCommands.trim() !== "") {
			commandsToProcess.push({ command: rawCommands })
		}

		if (script) {
			const wrappedCommand = this.wrapScript(script, language)
			const langDisplay = language.charAt(0).toUpperCase() + language.slice(1)
			commandsToProcess.push({
				command: wrappedCommand,
				displayName: `${langDisplay} script`,
			})
		}

		if (commandsToProcess.length === 0) {
			return formatResponse.toolResult("No commands provided to execute.")
		}

		// Extract provider
		const apiConfig = config.services.stateManager.getApiConfiguration()
		const currentMode = config.services.stateManager.getGlobalSettingsKey("mode")
		const provider = (currentMode === "plan" ? apiConfig.planModeApiProvider : apiConfig.actModeApiProvider) as string

		// Initialize multi-command state
		const multiCommandState: MultiCommandState = {
			commands: commandsToProcess.map((item) => ({
				command: item.command,
				displayName: item.displayName,
				status: "pending",
			})),
		}

		// Check if any command requires manual approval BEFORE creating the initial message
		const commandsRequiringApproval = []
		for (const cmdState of multiCommandState.commands) {
			const actualCommand = cmdState.command.trim()
			const isSafe = isSafeCommand(actualCommand)
			const autoApproveResult = config.autoApprover?.shouldAutoApproveTool(block.name)
			const autoApproveEnabled =
				typeof autoApproveResult === "boolean"
					? autoApproveResult
					: Array.isArray(autoApproveResult)
						? autoApproveResult[0]
						: false

			const isYolo = config.yoloModeToggled || config.services.stateManager.getGlobalSettingsKey("autoApproveAllToggled")
			if (!config.isSubagentExecution && !(isYolo || (isSafe && autoApproveEnabled))) {
				commandsRequiringApproval.push(actualCommand)
				cmdState.requiresApproval = true
			}
		}

		let initialResult: any
		let messageTs: number | undefined

		// Clean up any previous partial messages
		await config.callbacks.removeLastPartialMessageIfExistsWithType("ask", "tool")
		await config.callbacks.removeLastPartialMessageIfExistsWithType("say", "tool")

		if (commandsRequiringApproval.length > 0) {
			showNotificationForApproval(
				`Dirac wants to execute ${commandsRequiringApproval.length} commands`,
				config.autoApprovalSettings.enableNotifications,
			)

			// Ask for approval once for all commands
			initialResult = await ToolResultUtils.askApprovalAndPushFeedback(
				"command",
				commandsToProcess[0].command,
				config,
				false,
				multiCommandState,
			)
			messageTs = initialResult.askTs

			if (!initialResult.didApprove) {
				for (const cmdState of multiCommandState.commands) {
					if (cmdState.status === "pending") {
						cmdState.requiresApproval = false
						cmdState.status = "skipped"
						cmdState.output = "Command denied by user."
					}
				}
				
				if (messageTs !== undefined) {
					const messages = config.callbacks.getDiracMessages()
					const index = messages.findIndex((m) => m.ts === messageTs)
					if (index !== -1) {
						await config.callbacks.updateDiracMessage(index, { multiCommandState: { ...multiCommandState } })
					}
				}
				
				return formatResponse.toolResult("Commands denied by user.")
			}

			// Clear requiresApproval flag for all commands since they were approved
			for (const cmdState of multiCommandState.commands) {
				cmdState.requiresApproval = false
			}
			
			if (messageTs !== undefined) {
				const messages = config.callbacks.getDiracMessages()
				const index = messages.findIndex((m) => m.ts === messageTs)
				if (index !== -1) {
					await config.callbacks.updateDiracMessage(index, { multiCommandState: { ...multiCommandState } })
				}
			}
		} else {
			// Initial message to show all commands
			initialResult = await ToolResultUtils.askApprovalAndPushFeedback(
				"command",
				commandsToProcess[0].command,
				config,
				true,
				multiCommandState,
			)
			messageTs = initialResult.askTs
		}

		const updateMessage = async () => {
			if (messageTs === undefined) return
			const messages = config.callbacks.getDiracMessages()
			const index = messages.findIndex((m) => m.ts === messageTs)
			if (index !== -1) {
				await config.callbacks.updateDiracMessage(index, {
					multiCommandState: { ...multiCommandState },
					commandCompleted: false,
					partial: false,
				})
			}
		}

		const results: string[] = []
		let anyFailed = false
		let anySucceeded = false

		for (let i = 0; i < multiCommandState.commands.length; i++) {
			const cmdState = multiCommandState.commands[i]
			const originalCommand = cmdState.command
			const displayName = cmdState.displayName || originalCommand

			// Pre-process command (Gemini fix)
			let commandToExecute = originalCommand
			if (config.api.getModel().id.includes("gemini")) {
				commandToExecute = applyModelContentFixes(originalCommand)
			}

			// Handle multi-workspace hint
			let executionDir: string = config.cwd
			let actualCommand: string = commandToExecute
			let workspaceHint: string | undefined

			if (config.isMultiRootEnabled && config.workspaceManager) {
				const commandMatch = commandToExecute.match(/^@(\w+):(.+)$/)
				if (commandMatch) {
					workspaceHint = commandMatch[1]
					actualCommand = commandMatch[2].trim()
					const adapter = new WorkspacePathAdapter({
						cwd: config.cwd,
						isMultiRootEnabled: true,
						workspaceManager: config.workspaceManager,
					})
					executionDir = adapter.resolvePath(".", workspaceHint)
				}
			}

			// Permission validation
			const permissionResult = config.services.commandPermissionController.validateCommand(actualCommand)
			if (!permissionResult.allowed) {
				let errorMessage = `Command "${actualCommand}" was denied by DIRAC_COMMAND_PERMISSIONS.`
				if (permissionResult.failedSegment) {
					errorMessage += ` Segment "${permissionResult.failedSegment}" ${permissionResult.reason}.`
				} else {
					const matched = permissionResult.matchedPattern
						? ` (matched pattern: ${permissionResult.matchedPattern})`
						: ""
					errorMessage += ` Reason: ${permissionResult.reason}${matched}`
				}

				cmdState.status = "failed"
				cmdState.output = errorMessage
				await updateMessage()

				results.push(`--- Output for '${displayName}' ---\n${errorMessage}`)
				anyFailed = true
				continue
			}

			// Diracignore validation
			const ignoredFileAttemptedToAccess = config.services.diracIgnoreController.validateCommand(actualCommand)
			if (ignoredFileAttemptedToAccess) {
				cmdState.status = "failed"
				cmdState.output = `Diracignore error: ${ignoredFileAttemptedToAccess}`
				await updateMessage()

				results.push(`--- Output for '${displayName}' ---\nDiracignore error: ${ignoredFileAttemptedToAccess}`)
				anyFailed = true
				continue
			}

			// Safety check for auto-approval
			const isSafe = isSafeCommand(actualCommand)
			const autoApproveResult = config.autoApprover?.shouldAutoApproveTool(block.name)
			const autoApproveEnabled = Array.isArray(autoApproveResult) ? autoApproveResult[0] : autoApproveResult

			let didAutoApprove = false
			const isYolo = config.yoloModeToggled || config.services.stateManager.getGlobalSettingsKey("autoApproveAllToggled")
			if (config.isSubagentExecution || isYolo || (isSafe && autoApproveEnabled)) {
				didAutoApprove = true
				cmdState.wasAutoApproved = true
			}

			// Telemetry
			telemetryService.captureToolUsage(
				config.ulid,
				block.name,
				config.api.getModel().id,
				provider,
				didAutoApprove,
				true,
				{
					isMultiRootEnabled: config.isMultiRootEnabled || false,
					usedWorkspaceHint: !!workspaceHint,
					resolvedToNonPrimary: executionDir !== config.cwd,
					resolutionMethod: workspaceHint ? "hint" : "primary_fallback",
				},
				block.isNativeToolCall,
			)

			// Pre-tool hook
			try {
				const { ToolHookUtils } = await import("../utils/ToolHookUtils")
				await ToolHookUtils.runPreToolUseIfEnabled(config, block)
			} catch (error) {
				const { PreToolUseHookCancellationError } = await import("@core/hooks/PreToolUseHookCancellationError")
				if (error instanceof PreToolUseHookCancellationError) {
					cmdState.status = "failed"
					cmdState.output = "Cancelled by pre-tool hook."
					await updateMessage()
					results.push(`--- Output for '${displayName}' ---\nCancelled by pre-tool hook.`)
					anyFailed = true
					continue
				}
				throw error
			}

			// Execution
			cmdState.status = "running"
			await updateMessage()

			let lastUpdate = 0
			const updateInterval = 200 // ms
			let updateTimer: NodeJS.Timeout | null = null

			const throttledUpdate = async () => {
				const now = Date.now()
				if (now - lastUpdate >= updateInterval) {
					lastUpdate = now
					if (updateTimer) {
						clearTimeout(updateTimer)
						updateTimer = null
					}
					await updateMessage()
				} else if (!updateTimer) {
					updateTimer = setTimeout(async () => {
						updateTimer = null
						await throttledUpdate()
					}, updateInterval - (now - lastUpdate))
				}
			}

			let finalCommand: string = actualCommand
			if (executionDir !== config.cwd) {
				finalCommand = `cd "${executionDir}" && ${actualCommand}`
			}

			const timeoutSeconds = resolveCommandTimeoutSeconds(actualCommand, true)

			try {
				const [userRejected, result] = await config.callbacks.executeCommandTool(finalCommand, timeoutSeconds, {
					suppressUserInteraction: true,
					useBackgroundExecution: true,
					onOutputLine: (line) => {
						const currentOutput = cmdState.output || ""
						if (currentOutput.includes("... [Output truncated")) {
							return
						}
						const newOutput = currentOutput + line + "\n"
						if (newOutput.length >= MAX_COMMAND_OUTPUT_SIZE) {
							cmdState.output = truncateHeadTail(newOutput, MAX_COMMAND_OUTPUT_SIZE)
						} else {
							cmdState.output = newOutput
						}
						throttledUpdate()
					},
				})

				if (userRejected) {
					config.taskState.didRejectTool = true
					cmdState.status = "failed"
					cmdState.output = "Command was rejected or interrupted during execution."
					await updateMessage()
					results.push(`--- Output for '${displayName}' ---\nCommand was rejected or interrupted during execution.`)
					anyFailed = true
				} else {
					const rawOutput =
						typeof result === "string"
							? result
							: Array.isArray(result)
								? result.map((c: any) => c.text || "").join("\n")
								: JSON.stringify(result)

					const output = truncateHeadTail(rawOutput, MAX_COMMAND_OUTPUT_SIZE)

					cmdState.status = "completed"
					cmdState.output = output
					await updateMessage()

					results.push(`--- Output for '${displayName}' ---\n${output}`)
					anySucceeded = true
				}
			} catch (error) {
				cmdState.status = "failed"
				cmdState.output = `Error during execution: ${error instanceof Error ? error.message : String(error)}`
				await updateMessage()
				results.push(`--- Output for '${displayName}' ---\n${cmdState.output}`)
				anyFailed = true
			} finally {
				if (updateTimer) {
					clearTimeout(updateTimer)
					updateTimer = null
				}
			}
		}

		// Update consecutive mistake count
		if (anyFailed) {
			config.taskState.consecutiveMistakeCount++
		} else if (anySucceeded) {
			config.taskState.consecutiveMistakeCount = 0
		}

		// Mark the final message as completed
		const messages = config.callbacks.getDiracMessages()
		const index = messages.findIndex((m) => m.ts === messageTs)
		if (index !== -1) {
			await config.callbacks.updateDiracMessage(index, {
				commandCompleted: true,
				partial: false,
			})
		}

		return formatResponse.toolResult(results.join("\n\n"))
	}

	private wrapScript(script: string, language: string): string {
		const delimiter = `EOF_DIRAC_SCRIPT_${Math.random().toString(36).substring(2, 10).toUpperCase()}`
		const normalizedLanguage = language.toLowerCase().trim()

		let interpreter = "bash"
		if (normalizedLanguage === "python" || normalizedLanguage === "python3") {
			interpreter = "python3"
		} else if (normalizedLanguage === "node" || normalizedLanguage === "javascript") {
			interpreter = "node"
		} else if (normalizedLanguage === "sh") {
			interpreter = "sh"
		} else if (normalizedLanguage === "ruby") {
			interpreter = "ruby"
		} else if (normalizedLanguage === "perl") {
			interpreter = "perl"
		} else {
			interpreter = normalizedLanguage
		}

		return `${interpreter} << '${delimiter}'\n${script}\n${delimiter}`
	}
}
