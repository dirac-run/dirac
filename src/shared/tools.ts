import { Tool as AnthropicTool } from "@anthropic-ai/sdk/resources/index"
import { FunctionDeclaration as GoogleTool } from "@google/genai"
import { ChatCompletionTool as OpenAITool } from "openai/resources/chat/completions"

export type DiracTool = OpenAITool | AnthropicTool | GoogleTool


export interface DiracToolSpecParameter<TContext = any> {
    name: string
    required: boolean
    instruction: string | ((context: TContext) => string)
    usage?: string
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
    instruction?: string
    contextRequirements?: (context: TContext) => boolean
    parameters?: Array<DiracToolSpecParameter<TContext>>
}

// Define available tool ids
export enum DiracDefaultTool {
    SAY = "say",
    ASK = "ask_followup_question",
    ATTEMPT = "attempt_completion",
    BASH = "execute_command",
    FILE_READ = "read_file",
    FILE_NEW = "write_to_file",
    SEARCH = "search_files",
    LIST_FILES = "list_files",
    BROWSER = "browser_action",
    NEW_TASK = "new_task",
    PLAN_MODE = "plan_mode_respond",
    CONDENSE = "condense",
    SUMMARIZE_TASK = "summarize_task",
    REPORT_BUG = "report_bug",
    NEW_RULE = "new_rule",
    USE_SKILL = "use_skill",
    LIST_SKILLS = "list_skills",
    USE_SUBAGENTS = "use_subagents",
    GET_FUNCTION = "get_function",
    GET_FILE_SKELETON = "get_file_skeleton",
    FIND_SYMBOL_REFERENCES = "find_symbol_references",

    EDIT_FILE = "edit_file",
    DIAGNOSTICS_SCAN = "diagnostics_scan",
    REPLACE_SYMBOL = "replace_symbol",
    RENAME_SYMBOL = "rename_symbol",
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
    DiracDefaultTool.ASK,
    DiracDefaultTool.SAY,
    DiracDefaultTool.GET_FUNCTION,
    DiracDefaultTool.GET_FILE_SKELETON,
    DiracDefaultTool.FIND_SYMBOL_REFERENCES,
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
    DiracDefaultTool.REPLACE_SYMBOL,
    DiracDefaultTool.RENAME_SYMBOL,
    DiracDefaultTool.NEW_RULE,
    DiracDefaultTool.BASH, // conservatively treat bash as it can modify the filesystem
]

export function isMutatingTool(toolName: string): boolean {
    return MUTATING_TOOLS.includes(toolName as DiracDefaultTool)
}
