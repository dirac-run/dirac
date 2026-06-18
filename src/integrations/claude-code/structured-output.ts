import type { DiracTool } from "@/shared/tools"

/**
 * Name of the tool the `claude` CLI injects when `--json-schema` is provided.
 * The model "calls" this tool with our schema-shaped payload instead of using
 * any real built-in tool.
 */
export const STRUCTURED_OUTPUT_TOOL_NAME = "StructuredOutput"

export interface StructuredToolCall {
	tool: string
	params: Record<string, any>
}

/**
 * Extracts the tool name and parameters from a single converted tool definition.
 * Supports the three converter output shapes that `DiracTool` can take
 * (OpenAI function, Anthropic input_schema, Google function declaration).
 */
function readToolDefinition(tool: DiracTool): { name: string; description?: string; params?: Record<string, any> } | null {
	const anyTool = tool as any

	// OpenAI ChatCompletionTool: { type: "function", function: { name, description, parameters } }
	if (anyTool.type === "function" && anyTool.function) {
		const fn = anyTool.function
		if (!fn.name) {
			return null
		}
		return { name: fn.name, description: fn.description, params: fn.parameters }
	}

	// Anthropic Tool: { name, description, input_schema }
	if (anyTool.name && anyTool.input_schema) {
		return { name: anyTool.name, description: anyTool.description, params: anyTool.input_schema }
	}

	// Google FunctionDeclaration: { name, description, parameters }
	if (anyTool.name && anyTool.parameters) {
		return { name: anyTool.name, description: anyTool.description, params: anyTool.parameters }
	}

	return null
}

/**
 * Builds the JSON schema passed to `claude --json-schema`. The schema constrains
 * the model's output to one or more tool calls, embedding each tool's name as a
 * `const` discriminator and its parameter schema so the model sees the full tool
 * contract (this replaces the native `tools` API payload the CLI cannot accept).
 */
export function buildStructuredToolSchema(tools: DiracTool[]): Record<string, any> {
	const items = tools
		.map(readToolDefinition)
		.filter((def): def is NonNullable<ReturnType<typeof readToolDefinition>> => def !== null)
		.map((def) => ({
			type: "object",
			...(def.description ? { description: def.description } : {}),
			properties: {
				tool: { const: def.name },
				params: def.params ?? { type: "object" },
			},
			required: ["tool", "params"],
			additionalProperties: false,
		}))

	return {
		type: "object",
		properties: {
			tool_calls: {
				type: "array",
				minItems: 1,
				items: items.length > 0 ? { oneOf: items } : { type: "object" },
			},
		},
		required: ["tool_calls"],
		additionalProperties: false,
	}
}

/**
 * Unwraps the payload the model provided to the injected `StructuredOutput` tool
 * into a flat list of tool calls. Accepts both the array form
 * (`{ tool_calls: [{ tool, params }, ...] }`) and the single form
 * (`{ tool, params }`).
 */
export function extractStructuredToolCalls(input: unknown): StructuredToolCall[] {
	if (!input || typeof input !== "object") {
		return []
	}
	const obj = input as Record<string, any>

	if (Array.isArray(obj.tool_calls)) {
		return obj.tool_calls
			.filter((call) => call && typeof call === "object" && typeof call.tool === "string")
			.map((call) => ({ tool: call.tool, params: call.params ?? {} }))
	}

	if (typeof obj.tool === "string") {
		return [{ tool: obj.tool, params: obj.params ?? {} }]
	}

	return []
}
