import { LEGACY_RESPONSE_TOOLS, RESPOND_TOOL_NAME, ResponseOperation } from "@shared/responseTool"
import type { SubagentIdentity } from "@shared/subagents"
import { DiracDefaultTool } from "@shared/tools"
import type { ModelProviderSelection } from "@/shared/api"
import type { SubagentRuntime, TaskConfig } from "../types/TaskConfig"
import type { AgentBaseConfig } from "./AgentConfigLoader"
import { AgentConfigLoader } from "./AgentConfigLoader"
import type { SubagentRunRecorder } from "./SubagentRunRecorder"

export type AgentConfig = Partial<AgentBaseConfig>

export interface SubagentBuilderOptions {
	allowedTools?: string[]
	systemSuffix?: string
	agentIdentity?: SubagentIdentity
	recorder?: SubagentRunRecorder
	utilityModelSelection?: ModelProviderSelection
}

export const SUBAGENT_DEFAULT_ALLOWED_TOOLS: string[] = [
	...Object.values(DiracDefaultTool).filter(
		(tool) =>
			tool !== DiracDefaultTool.USE_SUBAGENTS &&
			tool !== DiracDefaultTool.NEW_TASK &&
			tool !== DiracDefaultTool.CONDENSE &&
			tool !== DiracDefaultTool.RESPOND,
	),
	`${RESPOND_TOOL_NAME}:${ResponseOperation.PROGRESS}`,
	`${RESPOND_TOOL_NAME}:${ResponseOperation.COMPLETE}`,
]

export const SUBAGENT_SYSTEM_SUFFIX = `\n\n# Subagent Execution Mode
You are a first-class subagent spawned by the main agent to execute a delegated task. Complete the requested work and report back.
Use the available tools to research, create, modify, or delete files, run commands, and verify work as the task requires. Follow the current task mode and applicable instructions, and stay within your delegated task scope.
Call respond with operation "complete" when finished or unable to make progress. Summarize completed work, relevant file paths, verification results, and any blockers or remaining work.
`

export const SUBAGENT_PROGRESS_INSTRUCTION = `
During the task, use respond with operation "progress" for timely trajectory updates at important points, such as a key finding, decision, blocker, or change in approach. Keep each update to one or two lines and skip routine or verbose status reports.
`

export class SubagentBuilder {
	private readonly agentConfig: AgentConfig = {}
	private readonly allowedTools: string[]
	private readonly runtime: SubagentRuntime
	private readonly providerId: string

	constructor(
		private readonly baseConfig: TaskConfig,
		subagentName?: string,
		private readonly options: SubagentBuilderOptions = {},
	) {
		const subagentConfig = AgentConfigLoader.getInstance().getCachedConfig(subagentName)
		this.agentConfig = subagentConfig ?? {}
		this.allowedTools = this.resolveAllowedTools(this.agentConfig.tools)

		const runtime = this.baseConfig.callbacks.createSubagentRuntime({
			modelId: this.agentConfig.modelId,
			utilityModelSelection: this.options.utilityModelSelection,
		})
		this.providerId = runtime.providerId
		this.runtime = runtime
	}

	getRuntime(): SubagentRuntime {
		return this.runtime
	}

	getProviderId(): string {
		return this.providerId
	}

	getAllowedTools(): string[] {
		return this.allowedTools
	}

	getConfiguredSkills(): string[] | undefined {
		return this.agentConfig.skills
	}

	buildSystemPrompt(generatedSystemPrompt: string): string {
		const configuredSystemPrompt = this.agentConfig?.systemPrompt?.trim()
		const systemPrompt = configuredSystemPrompt || generatedSystemPrompt
		return `${systemPrompt}${this.buildAgentIdentitySystemPrefix()}${this.options.systemSuffix ?? SUBAGENT_SYSTEM_SUFFIX}${SUBAGENT_PROGRESS_INSTRUCTION}`
	}

	private resolveAllowedTools(configuredTools?: string[]): string[] {
		const sourceTools =
			this.options.allowedTools ??
			(configuredTools && configuredTools.length > 0 ? configuredTools : SUBAGENT_DEFAULT_ALLOWED_TOOLS)
		const migrated = sourceTools.map((tool) => {
			const operation = LEGACY_RESPONSE_TOOLS[tool as keyof typeof LEGACY_RESPONSE_TOOLS]
			return operation ? `${RESPOND_TOOL_NAME}:${operation}` : tool
		})
		return Array.from(
			new Set([
				...migrated,
				`${RESPOND_TOOL_NAME}:${ResponseOperation.PROGRESS}`,
				`${RESPOND_TOOL_NAME}:${ResponseOperation.COMPLETE}`,
			]),
		)
	}

	private buildAgentIdentitySystemPrefix(): string {
		const name = this.agentConfig?.name?.trim()
		const description = this.agentConfig?.description?.trim()
		if (!name && !description) {
			return ""
		}

		const lines = ["# Agent Profile"]
		if (name) {
			lines.push(`Name: ${name}`)
		}
		if (description) {
			lines.push(`Description: ${description}`)
		}

		return `${lines.join("\n")}\n\n`
	}
}
