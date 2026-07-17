/**
 * Shared tool utilities for CLI components
 * Centralizes tool name handling and categorization
 */

/**
 * Tools that perform file edits (create, modify, delete)
 * Used to determine when to show DiffView and skip dynamic rendering
 */
export const FILE_EDIT_TOOLS = new Set([
	"edit_file",
	"replace_symbol",
	"write_to_file",
	"rename_symbol",
	"edited_existing_file",
	"new_file_created",
	"editedExistingFile",
	"newFileCreated",
	"renameSymbol",
])

/**
 * Tools that save/modify files (subset used for "Save" button label)
 */
export const FILE_SAVE_TOOLS = new Set([
	"edit_file",
	"replace_symbol",
	"write_to_file",
	"rename_symbol",
	"edited_existing_file",
	"new_file_created",
	"editedExistingFile",
	"newFileCreated",
	"renameSymbol",
])

/**
 * Check if a tool name is a file edit tool
 */
export function isFileEditTool(toolName: string | undefined): boolean {
	if (!toolName) return false
	return FILE_EDIT_TOOLS.has(toolName) || FILE_EDIT_TOOLS.has(normalizeToolName(toolName))
}

/**
 * Check if a tool name is a file save tool (for button labeling)
 */
export function isFileSaveTool(toolName: string | undefined): boolean {
	if (!toolName) return false
	return FILE_SAVE_TOOLS.has(toolName) || FILE_SAVE_TOOLS.has(normalizeToolName(toolName))
}

/**
 * Normalize tool name to snake_case for consistent lookups
 * Handles both camelCase (readFile) and snake_case (read_file) inputs
 */
export function normalizeToolName(toolName: string): string {
	// Convert camelCase to snake_case
	return toolName.replace(/([a-z])([A-Z])/g, "$1_$2").toLowerCase()
}

/**
 * Tool descriptions for display
 * Uses snake_case keys - use normalizeToolName() before lookup
 */
export const TOOL_DESCRIPTIONS: Record<string, { ask: string; say: string }> = {
	// File operations
	read_file: { ask: "wants to read", say: "read" },
	edited_existing_file: { ask: "wants to edit", say: "edited" },
	new_file_created: { ask: "wants to create", say: "created" },
	file_deleted: { ask: "wants to delete", say: "deleted" },
	write_to_file: { ask: "wants to create", say: "created" },
	edit_file: { ask: "wants to edit", say: "edited" },
	replace_symbol: { ask: "wants to replace", say: "replaced" },
	rename_symbol: { ask: "wants to rename", say: "renamed" },

	// Directory operations
	list_files: { ask: "wants to view files in", say: "viewed files in" },
	list_files_top_level: { ask: "wants to view files in", say: "viewed files in" },
	list_files_recursive: { ask: "wants to view all files in", say: "viewed all files in" },
	list_code_definition_names: { ask: "wants to list code definitions in", say: "listed code definitions in" },
	search_files: { ask: "wants to search for", say: "searched for" },

	// Code Analysis
	find_symbol_references: { ask: "wants to find references for", say: "found references for" },
	get_function: { ask: "wants to extract", say: "extracted" },
	get_file_skeleton: { ask: "wants to read the structure of", say: "read the structure of" },
	diagnostics_scan: { ask: "wants to scan for diagnostics in", say: "scanned for diagnostics in" },

	// Command execution
	execute_command: { ask: "wants to run", say: "ran" },

	// Browser & Web
	browser_action: { ask: "wants to use the browser", say: "used the browser" },
	read_line_range: { ask: "wants to read a line range from", say: "read a line range from" },

	browser_action_result: { ask: "wants to see the browser result", say: "viewed the browser result" },
	// Agent Control
	use_subagents: { ask: "wants to start subagents", say: "started subagents" },
	use_skill: { ask: "wants to use a skill", say: "used a skill" },
	list_skills: { ask: "wants to list available skills", say: "listed available skills" },
	ask_followup_question: { ask: "wants to ask a question", say: "asked a question" },
	attempt_completion: { ask: "wants to complete the task", say: "completed the task" },
	new_task: { ask: "wants to create a new task", say: "created a new task" },
	plan_mode_respond: { ask: "wants to propose a plan", say: "proposed a plan" },
	focus_chain: { ask: "wants to update the todo list", say: "updated the todo list" },
	condense: { ask: "wants to condense the conversation", say: "condensed the conversation" },
	subagent: { ask: "wants to use a subagent", say: "used a subagent" },
}

/**
 * Default description for unknown tools
 */
export const DEFAULT_TOOL_DESCRIPTION = {
	ask: "wants to use a tool",
	say: "used a tool",
}

/**
 * Get tool description with normalized lookup
 */
export function getToolDescription(toolName: string): { ask: string; say: string } {
	const normalized = normalizeToolName(toolName)
	return TOOL_DESCRIPTIONS[normalized] || DEFAULT_TOOL_DESCRIPTION
}

/**
 * Safely parse JSON from message text
 * Returns the parsed object or a default value if parsing fails
 */
export function parseMessageJson<T>(text: string | undefined, defaultValue: T): T {
	if (!text) return defaultValue
	try {
		return JSON.parse(text) as T
	} catch {
		return defaultValue
	}
}

/**
 * Parse tool info from message text
 */
export function parseToolFromMessage(
	text: string | undefined,
): { toolName: string; args: Record<string, unknown>; result?: string } | null {
	if (!text) return null
	try {
		const parsed = JSON.parse(text)
		if (parsed.tool) {
			return {
				toolName: parsed.tool,
				args: parsed,
				result: parsed.content || parsed.output,
			}
		}
		return null
	} catch {
		return null
	}
}

/**
 * Format a list of items with a limit and "and X more"
 */
function formatList(items: string[], limit = 2): string {
	if (items.length === 0) return ""
	if (items.length === 1) return items[0]
	if (items.length <= limit) return items.join(", ")
	return `${items.slice(0, limit).join(", ")} and ${items.length - limit} more`
}

/**
 * Get the primary argument to display for a tool (file path, command, url, etc.)
 */
export function getToolMainArg(toolName: string, args: Record<string, unknown>): string {
	const normalized = normalizeToolName(toolName)

	// Helper to get value from args regardless of case (snake_case or camelCase)
	const getArg = (key: string) => {
		const snake = key.replace(/([a-z])([A-Z])/g, "$1_$2").toLowerCase()
		const camel = key.replace(/_([a-z])/g, (g) => g[1].toUpperCase())
		return args[snake] ?? args[camel]
	}

	// Helper to ensure we have an array of strings
	const asStringArray = (val: unknown): string[] => {
		if (Array.isArray(val)) return val.filter((v): v is string => typeof v === "string")
		if (typeof val === "string") return [val]
		return []
	}

	// Special handling for specific tools
	if (normalized === "get_function") {
		const functionNames = asStringArray(getArg("function_names") || getArg("function_name"))
		const paths = asStringArray(getArg("paths") || getArg("path"))

		const functionsStr = formatList(functionNames)
		const pathsStr = formatList(paths)

		if (functionsStr && pathsStr) return `${functionsStr} from ${pathsStr}`
		return functionsStr || pathsStr
	}

	if (normalized === "replace_symbol") {
		const replacements = Array.isArray(getArg("replacements")) ? (getArg("replacements") as any[]) : []
		if (replacements.length > 0) {
			const symbols = replacements.map((r) => r.symbol).filter((s): s is string => typeof s === "string")
			const paths = [...new Set(replacements.map((r) => r.path).filter((p): p is string => typeof p === "string"))]

			const symbolsStr = formatList(symbols)
			const pathsStr = formatList(paths)

			if (symbolsStr && pathsStr) return `${symbolsStr} in ${pathsStr}`
			return symbolsStr || pathsStr
		}

		const symbol = getArg("symbol")
		const path = getArg("path")
		if (typeof symbol === "string" && typeof path === "string") {
			return `${symbol} in ${path}`
		}
		return (typeof symbol === "string" ? symbol : "") || (typeof path === "string" ? path : "")
	}

	if (normalized === "edit_file") {
		const files = Array.isArray(getArg("files")) ? (getArg("files") as any[]) : []
		if (files.length > 0) {
			const paths = files.map((f) => f.path).filter((p): p is string => typeof p === "string")
			if (paths.length > 0) return formatList(paths)
		}

		const path = getArg("path")
		const filesCount = getArg("files_count")
		const editsCount = getArg("edits_count")

		if (typeof path === "string" && path !== "Multiple files") return path
		if (typeof filesCount === "number" && filesCount > 0) {
			return `${filesCount} files (${editsCount || 0} edits)`
		}
		if (typeof path === "string") return path
	}

	if (normalized === "rename_symbol") {
		const existingSymbol = getArg("existing_symbol") || getArg("existingSymbol")
		const newSymbol = getArg("new_symbol") || getArg("newSymbol")
		const paths = asStringArray(getArg("paths") || getArg("path"))

		if (typeof existingSymbol === "string" && typeof newSymbol === "string") {
			const base = `'${existingSymbol}' to '${newSymbol}'`
			return paths.length > 0 ? `${base} in ${formatList(paths)}` : base
		}
	}

	if (normalized === "find_symbol_references") {
		const symbols = asStringArray(getArg("symbols") || getArg("symbol"))
		const paths = asStringArray(getArg("paths") || getArg("path"))

		const symbolsStr = formatList(symbols)
		const pathsStr = formatList(paths)

		if (symbolsStr && pathsStr) return `${symbolsStr} in ${pathsStr}`
		return symbolsStr || pathsStr
	}

	// Generic argument extraction
	// Search files: show 'regex' in path(s)
	const regex = getArg("regex")
	if (typeof regex === "string") {
		const paths = asStringArray(getArg("paths") || getArg("path"))
		if (paths.length > 0) return `'${regex}' in ${formatList(paths)}`
		return `'${regex}'`
	}

	// File path
	const path = getArg("path") || getArg("file_path")
	if (typeof path === "string") return path

	// Multiple paths
	const paths = getArg("paths")
	if (Array.isArray(paths) && paths.length > 0) {
		const pathsStr = asStringArray(paths)
		if (pathsStr.length > 0) return formatList(pathsStr)
	}

	// Command - truncate long commands
	const command = getArg("command")
	if (typeof command === "string") {
		return command.length > 120 ? command.substring(0, 117) + "..." : command
	}

	// URL
	const url = getArg("url")
	if (typeof url === "string") return url

	// Search query
	const query = getArg("query")
	if (typeof query === "string") return query

	return ""
}
