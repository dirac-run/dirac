import { formatResponse } from "@core/formatResponse"
import { DiracAskResponse } from "@shared/WebviewMessage"
import { DiracIcon } from "@/shared/icons"
import { truncateHeadTail } from "../../../../../shared/content-limits"
import { CardStatus } from "../../../../../shared/ExtensionMessage"
import { DiracDefaultTool, DiracToolSpec } from "../../../../../shared/tools"
import { WorkspacePathAdapter } from "../../../../workspace/WorkspacePathAdapter"
import { IDiracTool } from "../../interfaces/IDiracTool"
import { ICardHandle, IToolEnvironment } from "../../interfaces/IToolEnvironment"
import { SurfaceType } from "../../interfaces/SurfaceType"
import { ToolSkippedByUserMessage } from "../../types/ToolSkippedByUserMessage"
import { resolveCommandTimeoutSeconds } from "../../utils/CommandTimeoutUtils"

import { shortenCommandForDisplay } from "./path-display"

const MAX_PATH_LENGTH = 255
const MAX_COMMAND_OUTPUT_SIZE = 10 * 1024

interface CommandApprovalRequirement {
	required: boolean
	utilityEligible: boolean
}

export interface NormalizedCommand {
	command: string
	displayName: string
	language?: string
}

interface WorkspaceHintMatch {
	workspaceHint: string
	command: string
}

function parseWorkspaceHint(cmd: string): WorkspaceHintMatch | null {
	const match = cmd.match(/^@(\w+):(.+)$/)
	if (!match) return null
	return {
		workspaceHint: match[1],
		command: match[2].trim(),
	}
}

export const execute_command_spec: DiracToolSpec = {
	id: DiracDefaultTool.BASH,
	name: "execute_command",
	description:
		"Executes CLI commands or scripts. Provide exactly one of `commands` or `script`. Use `commands` for simple command sequences and `script` for complex multi-line logic or data processing. Scripts have full access to the filesystem and environment. In multi-root workspaces, prefix commands with `@workspace:`.",
	parameters: [
		{
			name: "commands",
			required: false,
			type: "array",
			items: { type: "string" },
			instruction:
				"An array of CLI commands to execute in sequence. Use proper shell operators within each command. Do not use ~ for home directory. When running builds or parallel tasks, use the number of cores provided in SYSTEM INFO instead of 'nproc' to respect environment limits.",
		},
		{
			name: "script",
			required: false,
			type: "string",
			instruction:
				"A script to execute. Use this for complex multi-line logic or non-shell languages like Python or Node.js.",
		},
		{
			name: "language",
			required: false,
			type: "string",
			instruction: "The language of the script (e.g., 'bash', 'python', 'node'). Defaults to 'bash'.",
		},
	],
}

export class ExecuteCommandTool implements IDiracTool {
	constructor(
		private diracIgnoreController: any,
		private commandPermissionController: any,
		private autoApprover: any,
		private workspaceManager: any,
		private isMultiRootEnabled: boolean,
	) { }

	public spec(): DiracToolSpec {
		return execute_command_spec
	}

	public supportedSurfaces(): SurfaceType[] {
		return ["all"]
	}

	public async processCall(args: any, env: IToolEnvironment): Promise<any> {
		const commands = this.normalizeCommands(args)
		if (commands.length === 0) {
			throw new Error("Missing required parameter: 'commands' or 'script' must be provided and non-empty.")
		}

		this.validateCommands(commands)

		const utilityPermissionHandlingEnabled = env.config.permissionDecisionBinding !== undefined
		const approval = this.getCommandApprovalRequirement(commands, utilityPermissionHandlingEnabled)

		if (approval.required) {
			const { approved, message } = await this.requestApproval(
				commands,
				env,
				approval.utilityEligible,
				utilityPermissionHandlingEnabled,
			)
			if (!approved) {
				return message ? formatResponse.toolDeniedWithFeedback(message) : formatResponse.toolDenied()
			}
		}

		const { results, usedWorkspaceHint, resolvedToNonPrimary } = await this.executeCommands(commands, env)

		env.telemetry.captureCustomMetadata({
			commandCount: commands.length,
			usedWorkspaceHint,
			resolvedToNonPrimary,
			isMultiRootEnabled: this.isMultiRootEnabled,
		})

		return results.join("\n\n")
	}

	private validateCommands(commands: NormalizedCommand[]): void {
		for (const cmd of commands) {
			const parts = cmd.command.split(/\s+/)
			for (const part of parts) {
				if (
					(part.startsWith("/") || part.startsWith("./") || part.startsWith("../") || part.includes("/")) &&
					Buffer.byteLength(part) > MAX_PATH_LENGTH
				) {
					throw new Error(`Path argument exceeds maximum allowed length (${MAX_PATH_LENGTH} bytes).`)
				}
			}

			const ignoredFileAttemptedToAccess = this.diracIgnoreController.validateCommand(cmd.command)
			if (ignoredFileAttemptedToAccess) {
				throw new Error(`Diracignore error: ${ignoredFileAttemptedToAccess}`)
			}
		}
	}

	private getCommandApprovalRequirement(
		commands: NormalizedCommand[],
		utilityPermissionHandlingEnabled: boolean,
	): CommandApprovalRequirement {
		if (!utilityPermissionHandlingEnabled) {
			if (this.autoApprover.isUnrestrictedAutoApprove()) {
				return { required: false, utilityEligible: false }
			}
			for (const command of commands) {
				const actualCommand = this.stripWorkspaceHint(command.command)
				const permission = this.commandPermissionController.validateCommand(actualCommand)
				if (!permission.allowed || !this.autoApprover.isCommandAutoApproved(actualCommand)) {
					return { required: true, utilityEligible: false }
				}
			}
			return { required: false, utilityEligible: false }
		}

		const permissionResults = commands.map((command) => {
			const actualCommand = this.stripWorkspaceHint(command.command)
			return {
				actualCommand,
				permission: this.commandPermissionController.validateTool("execute_command", actualCommand),
			}
		})
		if (permissionResults.some(({ permission }) => !permission.allowed)) {
			return { required: true, utilityEligible: false }
		}
		if (this.autoApprover.isUnrestrictedAutoApprove()) {
			return { required: false, utilityEligible: false }
		}

		const requiresApproval = permissionResults.some(({ actualCommand, permission }) => {
			if (this.autoApprover.isCommandAutoApproved(actualCommand)) return false
			return !permission.matchedPattern
		})
		return { required: requiresApproval, utilityEligible: requiresApproval }
	}

	private async requestApproval(
		commands: NormalizedCommand[],
		env: IToolEnvironment,
		utilityEligible: boolean,
		utilityPermissionHandlingEnabled: boolean,
	): Promise<{ approved: boolean; message?: string }> {
		const label = this.permissionCardLabel(commands, env.config.cwd)
		const card =
			!env.config.isSubagentExecution || utilityPermissionHandlingEnabled
				? await env.ui.createCard({
					header: commands.length === 1 ? `Execute: ${label}` : `Execute ${label}?`,
					status: CardStatus.WAITING_FOR_INPUT,
					icon: DiracIcon.COMMAND,
					requireApproval: true,
					permissionRequestKind:
						utilityPermissionHandlingEnabled
							? (!utilityEligible ? "manual_tool" : "tool")
							: undefined,
					renderType: "markdown",
					maxHeight: 10000,
					rawInput: {
						commands: commands.map(({ command, displayName, language }) => ({ command, displayName, language })),
					},
					body: commands
						.map((command) => {
							const language = command.language || "bash"
							const header = command.displayName !== command.command ? `**${command.displayName}**\n` : ""
							return `${header}\`\`\`${language}\n${shortenCommandForDisplay(command.command, env.config.cwd)}\n\`\`\``
						})
						.join("\n"),
					collapsed: false,
				})
				: undefined

		if (!card) return { approved: false }

		let interaction: Awaited<ReturnType<ICardHandle["waitForInteraction"]>>
		try {
			interaction = await card.waitForInteraction()
		} catch (error) {
			if (error instanceof ToolSkippedByUserMessage) {
				await this.resolvePermissionCard(card, "Skipped", label, CardStatus.SKIPPED, "↩ Skipped by user")
			} else {
				await this.resolvePermissionCard(card, "Cancelled", label, CardStatus.CANCELLED)
			}
			throw error
		}

		if (interaction.action === DiracAskResponse.MESSAGE) {
			if (interaction.text) {
				await env.ui.upsertText(interaction.text, false, "user")
			}
			await this.resolvePermissionCard(card, "Skipped", label, CardStatus.SKIPPED, "↩ Skipped by user")
			return { approved: false, message: interaction.text }
		}
		if (interaction.action !== DiracAskResponse.APPROVE) {
			await this.resolvePermissionCard(card, "Rejected", label, CardStatus.CANCELLED, "Execution denied by user.")
			return { approved: false, message: interaction.text }
		}
		await this.resolvePermissionCard(card, "Approved", label, CardStatus.SUCCESS)
		return { approved: true }
	}

	private permissionCardLabel(commands: NormalizedCommand[], cwd?: string): string {
		return commands.length === 1 ? shortenCommandForDisplay(commands[0].displayName, cwd) : `${commands.length} commands`
	}

	private async resolvePermissionCard(
		card: ICardHandle,
		outcome: "Approved" | "Rejected" | "Skipped" | "Cancelled",
		label: string,
		status: CardStatus,
		body?: string,
	): Promise<void> {
		await card.update({
			header: `${outcome}: ${label}`,
			collapsed: true,
			...(body === undefined ? {} : { body }),
		})
		await card.finalize(status)
	}

	private async executeCommands(
		commands: NormalizedCommand[],
		env: IToolEnvironment,
	): Promise<{ results: string[]; usedWorkspaceHint: boolean; resolvedToNonPrimary: boolean }> {
		const results: string[] = []
		let usedWorkspaceHint = false
		let resolvedToNonPrimary = false

		for (let i = 0; i < commands.length; i++) {
			const cmd = commands[i]
			const {
				result,
				usedWorkspaceHint: usedHint,
				resolvedToNonPrimary: resolvedNonPrimary,
			} = await this.executeSingleCommand(cmd, i + 1, commands.length, env)

			results.push(result)
			if (usedHint) usedWorkspaceHint = true
			if (resolvedNonPrimary) resolvedToNonPrimary = true
		}

		return { results, usedWorkspaceHint, resolvedToNonPrimary }
	}

	private async executeSingleCommand(
		cmd: NormalizedCommand,
		index: number,
		total: number,
		env: IToolEnvironment,
	): Promise<{ result: string; usedWorkspaceHint: boolean; resolvedToNonPrimary: boolean }> {
		const header = `Executing ${index} of ${total}: ${shortenCommandForDisplay(cmd.displayName, env.config.cwd)}`

		const activeCard = !env.config.isSubagentExecution
			? await env.ui.createCard({
				header,
				icon: DiracIcon.COMMAND,
				collapsed: true,
				rawInput: { command: cmd.command, displayName: cmd.displayName, language: cmd.language ?? "bash" },
			})
			: null

		let usedWorkspaceHint = false
		let resolvedToNonPrimary = false

		try {
			let commandToExecute = cmd.command
			let executionDir

			if (this.isMultiRootEnabled && this.workspaceManager) {
				const parsedHint = parseWorkspaceHint(cmd.command)
				if (parsedHint) {
					usedWorkspaceHint = true
					commandToExecute = parsedHint.command
					const adapter = new WorkspacePathAdapter({
						cwd: env.config.cwd || process.cwd(),
						isMultiRootEnabled: true,
						workspaceManager: this.workspaceManager,
					})
					executionDir = adapter.resolvePath(".", parsedHint.workspaceHint)
					if (executionDir !== env.config.cwd) {
						resolvedToNonPrimary = true
					}
				}
			}

			if (executionDir) {
				commandToExecute = `cd "${executionDir}" && ${commandToExecute}`
			}

			const timeoutSeconds = resolveCommandTimeoutSeconds(commandToExecute, true)
			const commandResult = await env.system.executeCommand(commandToExecute, { timeout: timeoutSeconds })
			const output = typeof commandResult.output === "string" ? commandResult.output : JSON.stringify(commandResult.output)
			const truncatedOutput = truncateHeadTail(output, MAX_COMMAND_OUTPUT_SIZE)
			const commandFailed =
				commandResult.userRejected ||
				(commandResult.signal !== undefined && commandResult.signal !== null) ||
				(typeof commandResult.exitCode === "number" && commandResult.exitCode !== 0)

			if (activeCard) {
				await activeCard.update({
					header: `${commandFailed ? "Failed" : "Executed"}: ${cmd.displayName}`,
					body: [commandFailed ? "Error:" : "Executed:", "```", truncatedOutput, "```"].join("\n"),
					rawOutput: {
						output: truncatedOutput,
						userRejected: commandResult.userRejected,
						...(commandResult.exitCode === undefined ? {} : { exitCode: commandResult.exitCode }),
						...(commandResult.signal === undefined ? {} : { signal: commandResult.signal }),
					},
				})
				await activeCard.finalize(commandFailed ? CardStatus.ERROR : CardStatus.SUCCESS)
			}

			return {
				result: `--- Output for '${cmd.displayName}' ---\n${truncatedOutput}`,
				usedWorkspaceHint,
				resolvedToNonPrimary,
			}
		} catch (error: any) {
			if (activeCard) {
				await activeCard.update({ body: `Error: ${error.message}`, rawOutput: { error: error.message } })
				await activeCard.finalize(CardStatus.ERROR)
			}
			return {
				result: `--- Output for '${cmd.displayName}' ---\nError: ${error.message}`,
				usedWorkspaceHint,
				resolvedToNonPrimary,
			}
		}
	}

	private normalizeCommands(args: any): NormalizedCommand[] {
		const commands: NormalizedCommand[] = []
		if (Array.isArray(args.commands)) {
			args.commands.forEach((cmd: any) => {
				if (typeof cmd === "string" && cmd.trim() !== "") {
					commands.push({ command: cmd, displayName: cmd, language: "bash" })
				}
			})
		} else if (typeof args.commands === "string" && args.commands.trim() !== "") {
			commands.push({ command: args.commands, displayName: args.commands, language: "bash" })
		}

		if (args.script) {
			const language = args.language || "bash"
			const langDisplay = language.charAt(0).toUpperCase() + language.slice(1)
			commands.push({
				command: this.wrapScript(args.script, language),
				displayName: `${langDisplay} script`,
				language: language,
			})
		}
		return commands
	}

	private stripWorkspaceHint(cmd: string): string {
		return parseWorkspaceHint(cmd)?.command ?? cmd
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
