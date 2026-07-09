import { PromptRegistry } from "./registry/PromptRegistry"
import type { SystemPromptContext } from "./types"
import type { ToolRequestSnapshot } from "@core/task/tools/runtime/ToolSnapshot"

export { DiracToolSet } from "./registry/DiracToolSet"
export { SubagentBuilder } from "../../task/tools/subagent/SubagentBuilder"
export { PromptBuilder } from "./registry/PromptBuilder"
export { PromptRegistry } from "./registry/PromptRegistry"
export * from "./templates/placeholders"
export { TemplateEngine } from "./templates/TemplateEngine"
export * from "./types"

/**
 * Get the system prompt
 */
export async function getSystemPrompt(context: SystemPromptContext, toolSnapshot: ToolRequestSnapshot) {
	const registry = PromptRegistry.getInstance()
	const systemPrompt = await registry.get(context, toolSnapshot)
	return { systemPrompt }
}
