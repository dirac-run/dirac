import { DiracAskResponse } from "@shared/WebviewMessage"

import { DiracDefaultTool } from "../../../../../shared/tools"
import { IDiracTool } from "../../interfaces/IDiracTool"
import { IToolEnvironment } from "../../interfaces/IToolEnvironment"
import { formatResponse } from "@core/formatResponse"
import { CardStatus } from "../../../../../shared/ExtensionMessage"
import { DiracIcon } from "@/shared/icons"
import { SurfaceType } from "../../interfaces/SurfaceType"
import { DiracToolSpec } from "../../../../../shared/tools"
import { isSafeCommand } from "../../utils/CommandSafetyChecker"
import { WorkspacePathAdapter } from "../../../../workspace/WorkspacePathAdapter"
import { truncateHeadTail } from "../../../../../shared/content-limits"
import { resolveCommandTimeoutSeconds } from "../../utils/CommandTimeoutUtils"

import { shortenCommandForDisplay } from "./path-display"

const MAX_PATH_LENGTH = 255
const MAX_COMMAND_OUTPUT_SIZE = 10 * 1024


function exitCodeFromCommandResult(output: string): number | undefined {
	const match = output.match(/exit code (-?\d+)/i)
	return match ? Number.parseInt(match[1], 10) : undefined
}

export const execute_command_spec: DiracToolSpec = {
	id: DiracDefaultTool.BASH,
	name: "execute_command",
	description:
		"Executes CLI commands or scripts. " +
		"Use 'commands' for simple sequences of shell operations, can also be a single command. " +
		"Use 'script' for complex multi-line logic, data processing, or when a high-level language like Python or Node.js is more efficient than shell scripting. Default language is bash" +
		"'script' are also very useful for combinatorial problems such as looping over 'swap and try' pattern" +
		"Scripts have full access to the file system and current environment, be careful. " +
		"In multi-root workspaces, use the @workspace:command syntax for standard commands. " +
		"Leverage the full power of the environment's interpreters (bash, python, node, etc.) to accomplish tasks with minimal round-trips." +
		"NOTE: provide exactly one of the {commands,script}",
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
	) {}

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

		const approvalRequired = this.checkSecurity(commands)

		if (approvalRequired) {
			const { approved, message } = await this.requestApproval(commands, env)
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

	private validateCommands(commands: { command: string; displayName: string; language?: string }[]): void {
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

	private checkSecurity(commands: { command: string; displayName: string; language?: string }[]): boolean {
		// YOLO / auto-approve-all: skip all security checks entirely
		if (this.autoApprover.isUnrestrictedAutoApprove()) {
			return false
		}

		for (const cmd of commands) {
			const actualCommand = this.stripWorkspaceHint(cmd.command)
			const isSafe = isSafeCommand(actualCommand)
			const permissionResult = this.commandPermissionController.validateCommand(actualCommand)
			const isAllowedByRules = permissionResult.allowed
			const autoApproveResult = this.autoApprover.shouldAutoApproveTool(DiracDefaultTool.BASH)
			const autoApproveEnabled = Array.isArray(autoApproveResult) ? autoApproveResult[0] : autoApproveResult

			if (!(isSafe && isAllowedByRules && autoApproveEnabled)) {
				return true
			}
		}
		return false
	}

	private async requestApproval(
		commands: { command: string; displayName: string; language?: string }[],
		env: IToolEnvironment,
	): Promise<{ approved: boolean; message?: string }> {
		const card = !env.config.isSubagentExecution
			? await env.ui.createCard({
					header:
						commands.length === 1
							? `Execute: ${shortenCommandForDisplay(commands[0].displayName, env.config.cwd)}`
							: `Execute ${commands.length} commands?`,
					status: CardStatus.WAITING_FOR_INPUT,
					icon: DiracIcon.COMMAND,
					requireApproval: true,
					renderType: "markdown",
					maxHeight: 10000, // setting it to a high number to prevent scroll in a scroll

					rawInput: { commands: commands.map(({ command, displayName, language }) => ({ command, displayName, language })) },
					body: commands
						.map((c) => {
							const lang = c.language || "bash"
							const header = c.displayName !== c.command ? `**${c.displayName}**\n` : ""
							return `${header}\`\`\`${lang}\n${shortenCommandForDisplay(c.command, env.config.cwd)}\n\`\`\``
						})
						.join("\n"),
					collapsed: false,
				})
			: undefined

		if (!card) {
			return { approved: false }
		}
		const interaction = await card.waitForInteraction()
		if (interaction.action === DiracAskResponse.MESSAGE) {
			if (interaction.text) {
				await env.ui.upsertText(interaction.text, false, "user")
			}
			await card.update({ body: `↩ Skipped by user` })
			await card.finalize(CardStatus.SKIPPED)
			return { approved: false, message: interaction.text }
		}
		if (interaction.action !== DiracAskResponse.APPROVE) {
			await card.update({ body: `Execution denied by user.` })
			await card.finalize(CardStatus.CANCELLED)
			return { approved: false, message: interaction.text }
		}
		await card.finalize(CardStatus.SUCCESS)
		return { approved: true }
	}

	private async executeCommands(
		commands: { command: string; displayName: string; language?: string }[],
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
		cmd: { command: string; displayName: string; language?: string },
		index: number,
		total: number,
		env: IToolEnvironment,
	): Promise<{ result: string; usedWorkspaceHint: boolean; resolvedToNonPrimary: boolean }> {
		const header = `Executing command ${index} of ${total}: ${shortenCommandForDisplay(cmd.displayName, env.config.cwd)}`

		const activeCard = !env.config.isSubagentExecution
			? await env.ui.createCard({
					header: header.replace("Executing command", "Executing"),
					icon: DiracIcon.COMMAND,
					collapsed: true,

					rawInput: { command: cmd.command, displayName: cmd.displayName, language: cmd.language ?? "bash" },
				})
			: null
		if (activeCard) {
			await activeCard.update({ body: "```\n" })
		}

		let usedWorkspaceHint = false
		let resolvedToNonPrimary = false

		try {
			let commandToExecute = cmd.command
			let executionDir = undefined

			if (this.isMultiRootEnabled && this.workspaceManager) {
				const commandMatch = cmd.command.match(/^@(\w+):(.+)$/)
				if (commandMatch) {
					usedWorkspaceHint = true
					const workspaceHint = commandMatch[1]
					commandToExecute = commandMatch[2].trim()
					const adapter = new WorkspacePathAdapter({
						cwd: env.config.cwd || process.cwd(),
						isMultiRootEnabled: true,
						workspaceManager: this.workspaceManager,
					})
					executionDir = adapter.resolvePath(".", workspaceHint)
					if (executionDir !== env.config.cwd) {
						resolvedToNonPrimary = true
					}
				}
			}

			if (executionDir) {
				commandToExecute = `cd "${executionDir}" && ${commandToExecute}`
			}

			const timeoutSeconds = resolveCommandTimeoutSeconds(commandToExecute, true)

			const [userRejected, result] = await env.system.executeCommand(commandToExecute, {
				timeout: timeoutSeconds,
				onOutput: (chunk: string) => {
					if (activeCard) {
						activeCard.appendBody(chunk)
					}
				},
			})

			const output = typeof result === "string" ? result : JSON.stringify(result)
			const truncatedOutput = truncateHeadTail(output, MAX_COMMAND_OUTPUT_SIZE)

			if (activeCard) {
				await activeCard.update({
					header: `Executed: ${cmd.displayName}`,
					body: [userRejected ? "Error:" : "Executed:", "```", truncatedOutput, "```"].join("\n"),

					rawOutput: {
						output: truncatedOutput,
						userRejected,
						...(exitCodeFromCommandResult(output) === undefined ? {} : { exitCode: exitCodeFromCommandResult(output) }),
					},
				})
				await activeCard.finalize(userRejected ? CardStatus.ERROR : CardStatus.SUCCESS)
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

	private normalizeCommands(args: any): { command: string; displayName: string; language?: string }[] {
		const commands: { command: string; displayName: string; language?: string }[] = []
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
		const commandMatch = cmd.match(/^@(\w+):(.+)$/)
		return commandMatch ? commandMatch[2].trim() : cmd
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
