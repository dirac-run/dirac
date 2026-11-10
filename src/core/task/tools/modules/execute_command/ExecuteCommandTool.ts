import * as path from "node:path"
import { WorkspacePathAdapter } from "../../../../workspace/WorkspacePathAdapter"
import type { CommandApprovalRequest } from "../../interfaces/CommandApprovals"
import { formatResponse } from "@core/formatResponse"
import { DiracAskResponse } from "@shared/WebviewMessage"
import { DiracIcon } from "@/shared/icons"
import { truncateHeadTail } from "../../../../../shared/content-limits"
import { CardStatus } from "../../../../../shared/ExtensionMessage"
import { DiracDefaultTool, DiracToolSpec } from "../../../../../shared/tools"
import { IDiracTool } from "../../interfaces/IDiracTool"
import { ICardHandle, IToolEnvironment } from "../../interfaces/IToolEnvironment"
import { SurfaceType } from "../../interfaces/SurfaceType"
import { ToolSkippedByUserMessage } from "../../types/ToolSkippedByUserMessage"
import { resolveCommandTimeoutSeconds } from "../../utils/CommandTimeoutUtils"
import { resolveCommandApproval } from "../../autoApprove"

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
	script?: { source: string; interpreter: string }
}

interface PreparedCommand extends NormalizedCommand {
	approvalRequest: CommandApprovalRequest
	usedWorkspaceHint: boolean
	resolvedToNonPrimary: boolean
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
	id: DiracDefaultTool.EXECUTE_COMMAND,
	name: "execute_command",
	description:
		"Executes CLI commands or scripts. Provide exactly one of `commands` or `script`. Use `commands` for simple command sequences and `script` for complex multi-line logic or data processing. Scripts have full access to the filesystem and environment. When scripting exact file edits, check boundary bytes and preserve surrounding whitespace: deleting a complete line includes its terminating newline, not only its visible characters. In multi-root workspaces, prefix commands with `@workspace:`.",
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
		const commands = this.normalizeCommands(args).map((command) => this.prepareCommand(command, env))
		if (commands.length === 0) {
			throw new Error("Missing required parameter: 'commands' or 'script' must be provided and non-empty.")
		}
		this.validateCommands(commands)

		const requiresApproval = commands.filter(
			(command) =>
				this.getCommandApprovalRequirement([command], env.config.permissionDecisionBinding !== undefined).required,
		)
		let denialMessage: string | undefined
		const approve = async (missing: readonly number[]): Promise<boolean> => {
			const pending = missing.map((index) => requiresApproval[index])
			const utilityEnabled = env.config.permissionDecisionBinding !== undefined
			const approval = this.getCommandApprovalRequirement(pending, utilityEnabled)
			const result = await this.requestApproval(pending, env, approval.utilityEligible, utilityEnabled)
			denialMessage = result.message
			return result.approved
		}
		const grants = env.orchestration.commandApprovals
		if (requiresApproval.length > 0) {
			const approved = grants
				? await grants.authorize(
					requiresApproval.map(({ approvalRequest }) => approvalRequest),
					approve,
				)
				: await approve(requiresApproval.map((_, index) => index))
			if (!approved) {
				return denialMessage ? formatResponse.toolDeniedWithFeedback(denialMessage) : formatResponse.toolDenied()
			}
		}

		const { results, failed, usedWorkspaceHint, resolvedToNonPrimary } = await this.executeCommands(
			commands,
			env,
			new Set(requiresApproval),
		)
		if (failed) env.orchestration.reportFailure()
		env.telemetry.captureCustomMetadata({
			commandCount: commands.length,
			usedWorkspaceHint,
			resolvedToNonPrimary,
			isMultiRootEnabled: this.isMultiRootEnabled,
		})
		return results.join("\n\n")
	}

	private prepareCommand(cmd: NormalizedCommand, env: IToolEnvironment): PreparedCommand {
		const primaryCwd = path.resolve(env.config.cwd || process.cwd())
		const hint = this.isMultiRootEnabled && this.workspaceManager && !cmd.script ? parseWorkspaceHint(cmd.command) : null
		const cwd = hint
			? path.resolve(
				new WorkspacePathAdapter({
					cwd: primaryCwd,
					isMultiRootEnabled: true,
					workspaceManager: this.workspaceManager,
				}).resolvePath(".", hint.workspaceHint),
			)
			: primaryCwd
		const command = hint?.command ?? cmd.command
		return {
			...cmd,
			command,
			approvalRequest: {
				identity: cmd.script
					? { kind: "script", script: cmd.script.source, interpreter: cmd.script.interpreter, cwd }
					: { kind: "command", command, cwd },
				effectiveCommand: command,
			},
			usedWorkspaceHint: hint !== null,
			resolvedToNonPrimary: cwd !== primaryCwd,
		}
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
		return resolveCommandApproval(
			commands.map(({ command }) => command),
			utilityPermissionHandlingEnabled,
			this.autoApprover,
			this.commandPermissionController,
			DiracDefaultTool.EXECUTE_COMMAND,
		)
	}

	private async requestApproval(
		commands: PreparedCommand[],
		env: IToolEnvironment,
		utilityEligible: boolean,
		utilityPermissionHandlingEnabled: boolean,
	): Promise<{ approved: boolean; message?: string }> {
		const label = this.permissionCardLabel(commands, env.config.cwd)
		const card = await env.ui.createCard({
			header: commands.length === 1 ? `Execute: ${label}` : `Execute ${label}?`,
			status: CardStatus.WAITING_FOR_INPUT,
			icon: DiracIcon.COMMAND,
			requireApproval: true,
			permissionOperation: {
				kind: "commands",
				commands: commands.map(({ command }) => command),
				executionContexts: commands.map(({ command, approvalRequest }) => ({ command, cwd: approvalRequest.identity.cwd })),
			},
			permissionRequestKind: utilityPermissionHandlingEnabled ? (!utilityEligible ? "manual_tool" : "tool") : undefined,
			renderType: "markdown",
			maxHeight: 10000,
			rawInput: {
				commands: commands.map(({ command, displayName, language, approvalRequest }) => ({
					command,
					displayName,
					language,
					cwd: approvalRequest.identity.cwd,
				})),
			},
			body: commands
				.map((command) => {
					const language = command.language || "bash"
					const header = command.displayName !== command.command ? `**${command.displayName}**\n` : ""
					return `${header}Working directory: ${JSON.stringify(command.approvalRequest.identity.cwd)}\n\`\`\`${language}\n${shortenCommandForDisplay(command.command, env.config.cwd)}\n\`\`\``
				})
				.join("\n"),
			collapsed: false,
		})

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
		commands: PreparedCommand[],
		env: IToolEnvironment,
		requiresApproval: ReadonlySet<PreparedCommand>,
	): Promise<{ results: string[]; failed: boolean; usedWorkspaceHint: boolean; resolvedToNonPrimary: boolean }> {
		const results: string[] = []
		let failures = 0
		for (let i = 0; i < commands.length; i++) {
			const cmd = commands[i]
			const assertAuthorized = () => {
				this.validateCommands([cmd])
				if (requiresApproval.has(cmd)) env.orchestration.commandApprovals?.assertCurrent([cmd.approvalRequest])
				else if (this.getCommandApprovalRequirement([cmd], env.config.permissionDecisionBinding !== undefined).required) {
					throw new Error("Command now requires approval under the current permissions")
				}
			}
			assertAuthorized()
			const { result, failed } = await this.executeSingleCommand(cmd, i + 1, commands.length, env, assertAuthorized)
			results.push(result)
			if (failed) failures++
		}
		return {
			results,
			failed: failures === commands.length,
			usedWorkspaceHint: commands.some((command) => command.usedWorkspaceHint),
			resolvedToNonPrimary: commands.some((command) => command.resolvedToNonPrimary),
		}
	}

	private async executeSingleCommand(
		cmd: PreparedCommand,
		index: number,
		total: number,
		env: IToolEnvironment,
		assertAuthorized: () => void,
	): Promise<{ result: string; failed: boolean }> {
		const header = `Executing ${index} of ${total}: ${shortenCommandForDisplay(cmd.displayName, env.config.cwd)}`
		const activeCard = await env.ui.createCard({
			header,
			icon: DiracIcon.COMMAND,
			collapsed: true,
			rawInput: {
				command: cmd.command,
				cwd: cmd.approvalRequest.identity.cwd,
				displayName: cmd.displayName,
				language: cmd.language ?? "bash",
			},
		})
		try {
			assertAuthorized()
			const timeoutSeconds = resolveCommandTimeoutSeconds(cmd.command, true)
			const commandResult = await env.system.executeCommand(cmd.command, {
				timeout: timeoutSeconds,
				cwd: cmd.approvalRequest.identity.cwd,
				assertAuthorized,
			})
			const output = typeof commandResult.output === "string" ? commandResult.output : JSON.stringify(commandResult.output)
			const truncatedOutput = truncateHeadTail(output, MAX_COMMAND_OUTPUT_SIZE)
			const commandFailed =
				commandResult.userRejected ||
				(commandResult.signal !== undefined && commandResult.signal !== null) ||
				(typeof commandResult.exitCode === "number" && commandResult.exitCode !== 0)
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
			return { result: `--- Output for '${cmd.displayName}' ---\n${truncatedOutput}`, failed: commandFailed && !commandResult.userRejected }
		} catch (error: any) {
			if (env.orchestration.getTaskState("abortSignal").aborted) {
				await activeCard.finalize(CardStatus.CANCELLED)
				throw error
			}
			await activeCard.update({ body: `Error: ${error.message}`, rawOutput: { error: error.message } })
			await activeCard.finalize(CardStatus.ERROR)
			return { result: `--- Output for '${cmd.displayName}' ---\nError: ${error.message}`, failed: true }
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
			const normalizedLanguage = language.toLowerCase().trim()
			const interpreter =
				normalizedLanguage === "python" ? "python3" : normalizedLanguage === "javascript" ? "node" : normalizedLanguage
			const langDisplay = language.charAt(0).toUpperCase() + language.slice(1)
			commands.push({
				command: this.wrapScript(args.script, interpreter),
				script: { source: args.script, interpreter },
				displayName: `${langDisplay} script`,
				language: language,
			})
		}
		return commands
	}

	private wrapScript(script: string, interpreter: string): string {
		let delimiter: string
		do {
			delimiter = `EOF_DIRAC_SCRIPT_${Math.random().toString(36).substring(2, 10).toUpperCase()}`
		} while (script.split(/\r?\n/).includes(delimiter))
		return `${interpreter} << '${delimiter}'\n${script}\n${delimiter}`
	}
}
