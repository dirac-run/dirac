import React from "react"
import { SymbolOutput } from "./ToolOutput/SymbolOutput"
import { BrowserOutput } from "./ToolOutput/BrowserOutput"
import { SystemOutput } from "./ToolOutput/SystemOutput"
import { TerminalOutput } from "./ToolOutput/TerminalOutput"
import { EditFileOutput } from "./ToolOutput/EditFileOutput"

export const TOOL_COMPONENT_REGISTRY: Record<string, React.FC<any> | undefined> = {
	editFile: EditFileOutput,
	editedExistingFile: EditFileOutput,
	readFile: SymbolOutput,
	read_file: SymbolOutput,

	readLineRange: SymbolOutput,
	read_line_range: SymbolOutput,

	listFilesTopLevel: undefined,
	list_files_top_level: undefined,
	listFilesRecursive: undefined,
	list_files_recursive: undefined,
	listCodeDefinitionNames: SymbolOutput,
	searchFiles: undefined,
	search_files: undefined,
	getFunction: SymbolOutput,
	get_function: SymbolOutput,
	getFileSkeleton: SymbolOutput,
	get_file_skeleton: SymbolOutput,
	findSymbolReferences: SymbolOutput,
	find_symbol_references: SymbolOutput,
	replaceSymbol: SymbolOutput,
	replace_symbol: SymbolOutput,
	renameSymbol: SymbolOutput,
	rename_symbol: SymbolOutput,
	newFileCreated: EditFileOutput,
	fileDeleted: EditFileOutput,
	browser_action: BrowserOutput,
	browser_action_result: BrowserOutput,
	webFetch: SystemOutput,
	webSearch: SystemOutput,
	executeCommand: TerminalOutput,
	execute_command: TerminalOutput,
	diagnosticsScan: SystemOutput,
	diagnostics_scan: SystemOutput,
	subagent: SystemOutput,
}

export function getComponentForTool(toolName: string): React.FC<any> | undefined {
	return TOOL_COMPONENT_REGISTRY[toolName]
}
