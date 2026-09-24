import { Tool as AnthropicTool } from "@anthropic-ai/sdk/resources/index"
import { FunctionDeclaration as GoogleTool } from "@google/genai"
import { ChatCompletionTool as OpenAITool } from "openai/resources/chat/completions"

export type DiracTool = OpenAITool | AnthropicTool | GoogleTool

export interface DiracToolSpecParameter<TContext = any> {
	name: string
	required: boolean
	instruction: string | ((context: TContext) => string)
	dependencies?: DiracDefaultTool[]
	description?: string
	contextRequirements?: (context: TContext) => boolean
	/**
	 * The type of the parameter. Default to string if not provided.
	 * Supported types: string, boolean, integer, array, object
	 */
	type?: "string" | "boolean" | "integer" | "array" | "object"
	/**
	 * For array types, this defines the schema of array items
	 */
	items?: any
	/**
	 * For object types, this defines the properties
	 */
	properties?: Record<string, any>
	/**
	 * Additional JSON Schema fields to preserve from MCP tools
	 */
	[key: string]: any
}

export interface DiracToolSpec<TContext = any> {
	id: DiracDefaultTool | string
	name: string
	description: string
	/** Request-visible description; static description remains available to inventory UI. */
	promptDescription?: string | ((context: TContext) => string)
	instruction?: string
	contextRequirements?: (context: TContext) => boolean
	parameters?: Array<DiracToolSpecParameter<TContext>>
}

// Define available tool ids
export enum DiracDefaultTool {
	RESPOND = "respond",
	EXECUTE_COMMAND = "execute_command",
	FILE_READ = "read_file",
	FILE_NEW = "write_to_file",
	SEARCH = "search_files",
	LIST_FILES = "list_files",
	BROWSER = "browser_action",
	NEW_TASK = "new_task",
	CONDENSE = "condense",
	USE_SKILL = "use_skill",
	LIST_SKILLS = "list_skills",
	USE_SUBAGENTS = "use_subagents",
	INSPECT_AST = "inspect_ast",

	UPSERT_TOOL = "upsert_tool",

	EDIT_FILE = "edit_file",
	DIAGNOSTICS_SCAN = "diagnostics_scan",
	EDIT_AST = "edit_ast",
}

// Array of all tool names for compatibility
// Automatically generated from the enum values
export const toolUseNames = Object.values(DiracDefaultTool) as DiracDefaultTool[]

const dynamicToolUseNamesByNamespace = new Map<string, Set<string>>()

export function setDynamicToolUseNames(namespace: string, names: string[]): void {
	dynamicToolUseNamesByNamespace.set(namespace, new Set(names.map((name) => name.trim()).filter(Boolean)))
}

export function getToolUseNames(): string[] {
	const defaults = [...toolUseNames]
	const dynamic = Array.from(dynamicToolUseNamesByNamespace.values()).flatMap((set) => Array.from(set))
	return Array.from(new Set([...defaults, ...dynamic]))
}

// Tools that are safe to run in parallel with the initial checkpoint commit
// These are tools that do not modify the workspace state
export const READ_ONLY_TOOLS = [
	DiracDefaultTool.LIST_FILES,
	DiracDefaultTool.FILE_READ,
	DiracDefaultTool.SEARCH,
	DiracDefaultTool.BROWSER,
	DiracDefaultTool.INSPECT_AST,
	DiracDefaultTool.DIAGNOSTICS_SCAN,

	DiracDefaultTool.USE_SKILL,
	DiracDefaultTool.LIST_SKILLS,
	DiracDefaultTool.USE_SUBAGENTS,
] as const

// Tools that can modify the filesystem or workspace state.
// Used to determine if a checkpoint is needed after a tool-use turn.
export const MUTATING_TOOLS: DiracDefaultTool[] = [
	DiracDefaultTool.FILE_NEW,
	DiracDefaultTool.EDIT_FILE,
	DiracDefaultTool.EDIT_AST,
	DiracDefaultTool.EXECUTE_COMMAND, // conservatively treat bash as it can modify the filesystem
]

export function isMutatingTool(toolName: string): boolean {
	return MUTATING_TOOLS.includes(toolName as DiracDefaultTool)
}
