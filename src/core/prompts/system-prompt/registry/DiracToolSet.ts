import { AgentConfigLoader } from "@core/task/tools/subagent/AgentConfigLoader"
import { DiracDefaultTool, type DiracTool } from "@/shared/tools"
import {
	type DiracToolSpec,
	shouldUseStrictToolSchemas,
	toolSpecFunctionDeclarations,
	toolSpecFunctionDefinition,
	toolSpecInputSchema,
} from "../spec"
import { SystemPromptContext } from "../types"

export class DiracToolSet {
	private constructor() { }

	public static getDynamicSubagentToolSpecs(context: SystemPromptContext): DiracToolSpec[] {
		if (context.subagentsEnabled !== true) {
			return []
		}

		const agentConfigs = AgentConfigLoader.getInstance().getAllCachedConfigsWithToolNames()
		return agentConfigs.map(({ toolName, config }) => ({
			id: DiracDefaultTool.USE_SUBAGENTS,
			name: toolName,
			description: `Use the "${config.name}" subagent: ${config.description}`,
			contextRequirements: (ctx) => ctx.subagentsEnabled === true,
			parameters: [
				{
					name: "prompt",
					required: true,
					instruction: "Helpful instruction for the task that the subagent will perform.",
				},
				{
					name: "timeout",
					required: false,
					instruction: "Optional timeout in seconds for the subagent.",
				},
				{
					name: "max_turns",
					required: false,
					instruction: "Optional maximum number of turns for the subagent.",
				},
			],
		}))
	}

	public static withDynamicSubagentToolSpecs(registeredTools: DiracToolSpec[], context: SystemPromptContext): DiracToolSpec[] {
		const hasSubagentDispatcher = registeredTools.some((tool) => tool.id === DiracDefaultTool.USE_SUBAGENTS)
		if (!hasSubagentDispatcher) {
			return registeredTools
		}

		const dynamicSubagentTools = DiracToolSet.getDynamicSubagentToolSpecs(context)
		const includesDynamicSubagents = dynamicSubagentTools.length > 0
		const filteredRegistered = includesDynamicSubagents
			? registeredTools.filter((tool) => tool.id !== DiracDefaultTool.USE_SUBAGENTS)
			: registeredTools

		return [...filteredRegistered, ...dynamicSubagentTools]
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
