import { Tool as AnthropicTool } from "@anthropic-ai/sdk/resources/index"
import { FunctionDeclaration as GoogleTool, Type as GoogleToolParamType } from "@google/genai"
import { ChatCompletionTool as OpenAITool } from "openai/resources/chat/completions"
import { FunctionTool as OpenAIResponseFunctionTool, Tool as OpenAIResponseTool } from "openai/resources/responses/responses"
import { MULTI_ROOT_HINT } from "./constants"
import type { SystemPromptContext } from "./types"

import { DiracToolSpec as BaseSpec, DiracToolSpecParameter as BaseParam } from "@/shared/tools"

export type DiracToolSpec = BaseSpec<SystemPromptContext>
export type DiracToolSpecParameter = BaseParam<SystemPromptContext>

export function toolSpecFunctionDefinition(tool: DiracToolSpec, context: SystemPromptContext, strict = false): OpenAITool {
	if (tool.contextRequirements && !tool.contextRequirements(context)) {
		throw new Error(`Tool ${tool.name} does not meet context requirements`)
	}

	const nullableType = (type: unknown): unknown => {
		if (Array.isArray(type)) return type.includes("null") ? type : [...type, "null"]
		return type === "null" ? type : [type, "null"]
	}

	const processSchema = (schema: any, optional = false): any => {
		if (schema.type === "object") {
			const properties: Record<string, any> = {}
			const originalRequired = new Set<string>(schema.required ?? [])

			for (const [key, value] of Object.entries(schema.properties ?? {})) {
				properties[key] = processSchema(value, !originalRequired.has(key))
			}

			return {
				type: optional ? nullableType("object") : "object",
				properties,
				required: Object.keys(properties),
				additionalProperties: false,
				...(schema.description ? { description: schema.description } : {}),
			}
		}

		if (schema.type === "array" && schema.items) {
			return {
				type: optional ? nullableType("array") : "array",
				items: processSchema(schema.items),
				...(schema.description ? { description: schema.description } : {}),
			}
		}

		const { type, description, enum: enumValues } = schema
		const processedEnum = optional && enumValues && !enumValues.includes(null) ? [...enumValues, null] : enumValues
		return {
			type: optional ? nullableType(type) : type,
			...(description ? { description } : {}),
			...(processedEnum ? { enum: processedEnum } : {}),
		}
	}

	const properties: Record<string, any> = {}
	const required: string[] = []

	if (tool.parameters) {
		for (const param of tool.parameters) {
			if (param.contextRequirements && !param.contextRequirements(context)) {
				continue
			}

			if (param.required || strict) {
				required.push(param.name)
			}

			const paramType: string = param.type || "string"
			const paramSchema: any = {
				type: paramType,
				description: replacer(resolveInstruction(param.instruction, context), context),
			}

			if (paramType === "array" && param.items) {
				paramSchema.items = param.items
			}

			if (paramType === "object" && param.properties) {
				paramSchema.properties = param.properties
			}

			const reservedKeys = new Set([
				"name",
				"required",
				"instruction",
				"usage",
				"dependencies",
				"description",
				"contextRequirements",
				"type",
				"items",
				"properties",
			])

			for (const key in param) {
				if (!reservedKeys.has(key) && param[key] !== undefined) {
					paramSchema[key] = param[key]
				}
			}

			if (param.usage) {
				paramSchema.description += ` Example: ${param.usage}`
			}

			properties[param.name] = strict ? processSchema(paramSchema, !param.required) : paramSchema
		}
	}

	return {
		type: "function",
		function: {
			name: tool.name,
			strict,
			description: replacer(tool.description, context),
			parameters: {
				type: "object",
				properties,
				required,
				additionalProperties: false,
			},
		},
	}
}

/**
 * Converts a DiracToolSpec into an Anthropic Tool definition
 */
export function toolSpecInputSchema(tool: DiracToolSpec, context: SystemPromptContext): AnthropicTool {
	// Check if the tool should be included based on context requirements
	if (tool.contextRequirements && !tool.contextRequirements(context)) {
		throw new Error(`Tool ${tool.name} does not meet context requirements`)
	}

	// Build the properties object for parameters
	const properties: Record<string, any> = {}
	const required: string[] = []

	if (tool.parameters) {
		for (const param of tool.parameters) {
			// Check if parameter should be included based on context requirements
			if (param.contextRequirements && !param.contextRequirements(context)) {
				continue
			}

			// Add to required array if parameter is required
			if (param.required) {
				required.push(param.name)
			}

			// Determine parameter type - use explicit type if provided.
			// Default to string
			const paramType: string = param.type || "string"

			// Build parameter schema
			const paramSchema: any = {
				type: paramType,
				description: replacer(resolveInstruction(param.instruction, context), context),
			}

			// Add items for array types
			if (paramType === "array" && param.items) {
				paramSchema.items = param.items
			}

			// Add properties for object types
			if (paramType === "object" && param.properties) {
				paramSchema.properties = param.properties
			}

			const reservedKeys = new Set([
				"name",
				"required",
				"instruction",
				"usage",
				"dependencies",
				"description",
				"contextRequirements",
				"type",
				"items",
				"properties",
			])
			for (const key in param) {
				if (!reservedKeys.has(key) && param[key] !== undefined) {
					paramSchema[key] = param[key]
				}
			}

			// Add usage example as part of description if available
			// if (param.usage) {
			// 	paramSchema.description += ` Example: ${param.usage}`
			// }

			properties[param.name] = paramSchema
		}
	}

	// Build the Tool object
	const toolInputSchema: AnthropicTool = {
		name: tool.name,
		description: replacer(tool.description, context),
		input_schema: {
			type: "object",
			properties,
			required,
		},
	}

	return toolInputSchema
}

const GOOGLE_TOOL_PARAM_MAP: Record<string, string> = {
	string: "STRING",
	number: "NUMBER",
	integer: "NUMBER",
	boolean: "BOOLEAN",
	object: "OBJECT",
	array: "ARRAY",
}

/**
 * Converts a DiracToolSpec into a Google Gemini function.
 * Docs: https://ai.google.dev/gemini-api/docs/function-calling
 */
export function toolSpecFunctionDeclarations(tool: DiracToolSpec, context: SystemPromptContext): GoogleTool {
	// Check if the tool should be included based on context requirements
	if (tool.contextRequirements && !tool.contextRequirements(context)) {
		throw new Error(`Tool ${tool.name} does not meet context requirements`)
	}

	/**
	 * Recursively converts a JSON Schema-like property into a Google Gemini Schema.
	 */
	const toGoogleSchema = (prop: any): any => {
		const type = GOOGLE_TOOL_PARAM_MAP[prop.type || "string"] || GoogleToolParamType.OBJECT
		const schema: any = { type }

		if (prop.description) {
			schema.description = prop.description
		}

		if (prop.enum) {
			schema.enum = prop.enum
		}

		if ((type === "OBJECT" || type === GoogleToolParamType.OBJECT) && prop.properties) {
			schema.properties = {}
			const required: string[] = []
			for (const [key, value] of Object.entries<any>(prop.properties)) {
				if (key === "$schema") {
					continue
				}
				schema.properties[key] = toGoogleSchema(value)
				// Handle required fields in objects
				if (value.required || (Array.isArray(prop.required) && prop.required.includes(key))) {
					required.push(key)
				}
			}
			if (required.length > 0) {
				schema.required = required
			}
		}

		if ((type === "ARRAY" || type === GoogleToolParamType.ARRAY) && prop.items) {
			schema.items = toGoogleSchema(prop.items)
		}

		// Preserve any additional JSON Schema fields (e.g. pattern, format, etc.)
		const reservedKeys = new Set([
			"type",
			"description",
			"enum",
			"properties",
			"required",
			"items",
			"instruction",
			"name",
			"usage",
			"dependencies",
			"contextRequirements",
		])
		for (const key in prop) {
			if (!reservedKeys.has(key) && prop[key] !== undefined) {
				schema[key] = prop[key]
			}
		}

		return schema
	}

	// Build the parameters object
	const properties: Record<string, any> = {}
	const required: string[] = []

	if (tool.parameters) {
		for (const param of tool.parameters) {
			// Check if parameter should be included based on context requirements
			if (param.contextRequirements && !param.contextRequirements(context)) {
				continue
			}

			if (!param.name) {
				continue
			}

			// Add to required array if parameter is required
			if (param.required) {
				required.push(param.name)
			}

			// Top-level parameter schema
			const paramSchema = toGoogleSchema(param)

			// Resolve top-level instruction as description
			if (param.instruction) {
				const desc = replacer(resolveInstruction(param.instruction, context), context)
				if (desc) {
					paramSchema.description = desc
				}
			}

			properties[param.name] = paramSchema
		}
	}

	const googleTool: GoogleTool = {
		name: tool.name,
		description: replacer(tool.description, context),
		parameters: {
			type: GoogleToolParamType.OBJECT,
			properties,
			required,
		},
	}
	return googleTool
}

/**
 * Converts an OpenAI ChatCompletionTool into an Anthropic Tool definition
 */
export function openAIToolToAnthropic(openAITool: OpenAITool): AnthropicTool {
	if (openAITool.type === "function") {
		const func = openAITool.function
		return {
			name: func.name,
			description: func.description || "",
			input_schema: {
				type: "object",
				...(Object.keys(func.parameters?.properties || {}).length > 0
					? {
							properties: func.parameters?.properties,
							required: (func.parameters as any)?.required || [],
						}
					: {}),
			},
		}
	}

	return {
		name: openAITool.custom.name,
		description: openAITool.custom.description || "",
		input_schema: {
			type: "object",
			required: openAITool.custom.format?.type === "text" ? ["text"] : [],
			properties:
				openAITool.custom.format?.type === "text" ? { text: { type: "string" } } : { grammar: { type: "object" } },
		},
	}
}

/**
 * Converts OpenAI tools to Response API format.
 * Filters for function-type tools and applies Response API defaults.
 */
export function toOpenAIResponseTools(openAITools: OpenAITool[]): OpenAIResponseTool[] {
	if (!openAITools) {
		return []
	}

	return openAITools
		.filter((tool): tool is OpenAITool & { type: "function" } => tool.type === "function")
		.map((tool) => ({
			type: "function" as const,
			name: tool.function.name,
			description: tool.function.description,
			parameters: (tool.function.parameters as { [key: string]: unknown } | null) ?? null,
			strict: tool.function.strict ?? true,
		}))
}

/**
 * Converts an OpenAI ChatCompletionTool into Response API format.
 */
export function toOpenAIResponsesAPITool(openAITool: OpenAITool): OpenAIResponseTool {
	if (openAITool.type === "function") {
		const fn = openAITool.function
		return {
			type: "function",
			name: fn.name,
			description: fn.description || "",
			strict: fn.strict || false,
			parameters: {
				type: "object",
				properties: fn.parameters?.properties || {},
				required: (fn.parameters?.required as string[]) || [],
			},
		} satisfies OpenAIResponseFunctionTool
	}

	// Handle custom tool type
	const custom = openAITool.custom
	const isTextFormat = custom.format?.type === "text"

	return {
		type: "function",
		name: custom.name,
		description: custom.description || "",
		strict: false,
		parameters: {
			type: "object",
			properties: isTextFormat ? { text: { type: "string" } } : { grammar: { type: "object" } },
			required: ["text"],
		},
	} satisfies OpenAIResponseTool
}

/**
 * Replaces template placeholders in descriptions for native tool schemas.
 */
function replacer(description: string, context: SystemPromptContext): string {
	const width = context.browserSettings?.viewport?.width || 900
	const height = context.browserSettings?.viewport?.height || 600
	const cwd = context.cwd || process.cwd()
	const multiRootHint = context.isMultiRootEnabled ? MULTI_ROOT_HINT : ""

	return description
		.replace(/{{BROWSER_VIEWPORT_WIDTH}}/g, String(width))
		.replace(/{{BROWSER_VIEWPORT_HEIGHT}}/g, String(height))
		.replace(/{{CWD}}/g, cwd)
		.replace(/{{MULTI_ROOT_HINT}}/g, multiRootHint)
}

/**
 * Resolves an instruction that may be a string or a function.
 */
export function resolveInstruction(
	instruction: string | ((context: SystemPromptContext) => string),
	context: SystemPromptContext,
): string {
	return typeof instruction === "function" ? instruction(context) : instruction
}
