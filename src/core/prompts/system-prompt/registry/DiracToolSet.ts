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
	private constructor() {}

	public static withSubagentRoleSpecs(registeredTools: DiracToolSpec[], context: SystemPromptContext): DiracToolSpec[] {
		const roles = context.subagentRoles ?? []
		return registeredTools.map((tool) => {
			if (tool.id !== DiracDefaultTool.SUBAGENTS) return tool
			return {
				...tool,
				parameters: tool.parameters?.map((parameter) => {
					if (parameter.name !== "assignments") return parameter
					return {
						...parameter,
						items: {
							...parameter.items,
							properties: {
								...parameter.items.properties,
								type: {
									type: "string",
									enum: ["default", ...roles.map((role) => role.name)],
									description: ["default: Use the main agent's current model settings.", ...roles.map(({ name, description }) => `${name}: ${description}`)].join("\n"),
								},
							},
						},
					}
				}),
			}
		})
	}

	public static convertSpecsToNativeTools(specs: DiracToolSpec[], context: SystemPromptContext): DiracTool[] {
		const enabledTools = specs.filter((tool) => typeof tool.description === "string" && tool.description.trim().length > 0)
		const providerId = context.providerInfo?.providerId || "openai"
		const modelId = context.providerInfo?.model?.id
		const converter = DiracToolSet.getNativeConverter(providerId, modelId)
		return enabledTools.map((tool) => converter(tool, context))
	}

	public static getNativeConverter(providerId: string, modelId?: string) {
		switch (providerId) {
			case "minimax":
			case "anthropic":
			case "bedrock":
				return toolSpecInputSchema
			case "gemini":
				return toolSpecFunctionDeclarations
			case "vertex":
				if (modelId?.includes("gemini")) return toolSpecFunctionDeclarations
				return toolSpecInputSchema
			default:
				return (tool: DiracToolSpec, ctx: SystemPromptContext) => toolSpecFunctionDefinition(tool, ctx, shouldUseStrictToolSchemas(ctx.providerInfo))
		}
	}
}
