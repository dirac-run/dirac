import { AgentConfigLoader } from "@core/task/tools/subagent/AgentConfigLoader"
import { DEFAULT_SUBAGENT_TIMEOUT_SECONDS } from "@core/task/tools/subagent/SubagentExecutionPolicy"
import { SUBAGENT_TASK_TITLE_MAX_CHARS, SUBAGENT_TASK_TITLE_MAX_WORDS } from "@shared/subagents"
import { DiracDefaultTool, type DiracTool } from "@/shared/tools"
import {
	type DiracToolSpec,
	shouldUseStrictToolSchemas,
	toolSpecFunctionDeclarations,
	toolSpecFunctionDefinition,
	toolSpecInputSchema,
} from "../spec"
import { SystemPromptContext } from "../types"

const UTILITY_MODEL_PARAMETER = {
	name: "use_utility_model",
	required: false,
	type: "boolean" as const,
	instruction:
		"Run this subagent using the configured Utility model. 'Utility model' is a pre-configured model that is cost effective and fast, but unsuitable for complex tasks. Default: false.",
}

export class DiracToolSet {
	private constructor() {}

	public static getDynamicSubagentToolSpecs(context: SystemPromptContext): DiracToolSpec[] {
		if (context.subagentsEnabled !== true) {
			return []
		}

		const agentConfigs = AgentConfigLoader.getInstance().getAllCachedConfigsWithToolNames()
		return agentConfigs.map(({ toolName, config }) => ({
			id: DiracDefaultTool.USE_SUBAGENTS,
			name: toolName,
			description: `Start a tasklet asynchronously using the "${config.name}" subagent: ${config.description}. Returns a stable tasklet ID on startup acceptance or a startup failure, not the assignment's final result. Startup acceptance is not assignment success. Later results and requests arrive through parent communication and tasklets inspect. Continue useful work or use tasklets sleep to wait; do not rely on polling alone.`,
			contextRequirements: (ctx) => ctx.subagentsEnabled === true,
			parameters: [
				{
					name: "task_title",
					type: "string",
					required: true,
					instruction: `Task header for user observability. No more than ${SUBAGENT_TASK_TITLE_MAX_WORDS} words or ${SUBAGENT_TASK_TITLE_MAX_CHARS} characters.`,
				},
				{
					name: "prompt",
					type: "string",
					required: true,
					instruction: "Helpful instruction for the task that the subagent will perform.",
				},
				{
					name: "timeout",
					type: "integer",
					required: false,
					instruction: `Per-execution timeout in seconds, applied on start and each explicit resumption. Default: ${DEFAULT_SUBAGENT_TIMEOUT_SECONDS}. The deadline interrupts execution and retains the conversation and tasklet ID; continuing requires explicit tasklets resume. No 90-second wrap-up grace or automatic success.`,
				},
				{
					name: "include_history",
					type: "boolean",
					required: false,
					instruction: "Include the main task conversation history.",
				},
				...(context.utilityModelConfigured ? [UTILITY_MODEL_PARAMETER] : []),
			],
		}))
	}

	public static withDynamicSubagentToolSpecs(registeredTools: DiracToolSpec[], context: SystemPromptContext): DiracToolSpec[] {
		const contextualizedRegisteredTools = registeredTools.map((tool) => DiracToolSet.withUtilityModelParameter(tool, context))
		const hasSubagentDispatcher = contextualizedRegisteredTools.some((tool) => tool.id === DiracDefaultTool.USE_SUBAGENTS)
		if (!hasSubagentDispatcher) {
			return contextualizedRegisteredTools
		}

		const dynamicSubagentTools = DiracToolSet.getDynamicSubagentToolSpecs(context)
		const includesDynamicSubagents = dynamicSubagentTools.length > 0
		const filteredRegistered = includesDynamicSubagents
			? contextualizedRegisteredTools.filter((tool) => tool.id !== DiracDefaultTool.USE_SUBAGENTS)
			: contextualizedRegisteredTools

		return [...filteredRegistered, ...dynamicSubagentTools]
	}

	private static withUtilityModelParameter(tool: DiracToolSpec, context: SystemPromptContext): DiracToolSpec {
		if (
			context.utilityModelConfigured !== true ||
			tool.id !== DiracDefaultTool.USE_SUBAGENTS ||
			tool.name !== DiracDefaultTool.USE_SUBAGENTS
		) {
			return tool
		}

		return {
			...tool,
			parameters: tool.parameters?.map((parameter) => {
				if (parameter.name !== "subagents" || parameter.type !== "array" || !parameter.items?.properties) {
					return parameter
				}

				return {
					...parameter,
					items: {
						...parameter.items,
						properties: {
							...parameter.items.properties,
							use_utility_model: {
								type: "boolean",
								description: UTILITY_MODEL_PARAMETER.instruction,
							},
						},
					},
				}
			}),
		}
	}

	public static convertSpecsToNativeTools(specs: DiracToolSpec[], context: SystemPromptContext): DiracTool[] {
		const enabledTools = specs.filter((tool) => typeof tool.description === "string" && tool.description.trim().length > 0)
		const providerId = context.providerInfo?.providerId || "openai"
		const modelId = context.providerInfo?.model?.id
		const converter = DiracToolSet.getNativeConverter(providerId, modelId)

		return enabledTools.map((tool) => converter(tool, context))
	}

	/**
	 * Get the appropriate native tool converter for the given provider
	 */
	public static getNativeConverter(providerId: string, modelId?: string) {
		switch (providerId) {
			case "minimax":
			case "anthropic":
			case "bedrock":
				return toolSpecInputSchema
			case "gemini":
				return toolSpecFunctionDeclarations
			case "vertex":
				if (modelId?.includes("gemini")) {
					return toolSpecFunctionDeclarations
				}
				return toolSpecInputSchema
			default:
				// Default to OpenAI Compatible converter
				return (tool: DiracToolSpec, ctx: SystemPromptContext) =>
					toolSpecFunctionDefinition(tool, ctx, shouldUseStrictToolSchemas(ctx.providerInfo))
		}
	}
}
