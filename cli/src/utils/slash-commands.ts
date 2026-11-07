/**
 * Slash command utilities for CLI
 * Handles detection, filtering, and insertion of slash commands
 */

import type { SlashCommandInfo } from "@shared/proto/dirac/slash"
import { StateManager } from "@/core/storage/StateManager"
import { fuzzyFilter } from "./fuzzy-search"
import { CliPanelType } from "../types"

export interface SlashQueryInfo {
	inSlashMode: boolean
	query: string
	slashIndex: number
}

export interface VisibleWindow<T> {
	items: T[]
	startIndex: number
}

export type LocalSlashCommandPanel =
	| {
			type: CliPanelType.SETTINGS
			initialMode?: "model-picker" | "featured-models" | "provider-picker"
			initialModelKey?: "actModelId" | "planModelId"
	  }
	| { type: CliPanelType.HISTORY }
	| { type: CliPanelType.HELP }
	| { type: CliPanelType.SKILLS }
	| { type: CliPanelType.USAGE }
	| { type: CliPanelType.AGENTS }

export interface LocalSlashCommandContext {
	mode: string
	setActivePanel: (panel: LocalSlashCommandPanel) => void
	resetInputLine: () => void
	clearViewAndResetTask: () => void
	handleExit: () => void
	enableFastMode: () => void
	toggleQuietMode: () => void
	showAgentSnapshot: () => void
}

type LocalSlashCommandHandler = (context: LocalSlashCommandContext) => void

function openPanel(panel: LocalSlashCommandPanel): LocalSlashCommandHandler {
	return ({ setActivePanel, resetInputLine }) => {
		setActivePanel(panel)
		resetInputLine()
	}
}

function openModelsPanel({ mode, setActivePanel, resetInputLine }: LocalSlashCommandContext) {
	const apiConfig = StateManager.get().getApiConfiguration()
	const provider =
		mode === "act"
			? apiConfig.actModeApiProvider || apiConfig.planModeApiProvider
			: apiConfig.planModeApiProvider || apiConfig.actModeApiProvider
	const initialMode = provider ? "model-picker" : undefined
	const initialModelKey = mode === "act" ? "actModelId" : "planModelId"
	setActivePanel({ type: CliPanelType.SETTINGS, initialMode, initialModelKey })
	resetInputLine()
}

const LOCAL_SLASH_COMMANDS: Record<string, LocalSlashCommandHandler> = {
	help: openPanel({ type: CliPanelType.HELP }),
	settings: openPanel({ type: CliPanelType.SETTINGS }),
	models: openModelsPanel,
	history: openPanel({ type: CliPanelType.HISTORY }),
	agent: openPanel({ type: CliPanelType.AGENTS }),
	agents: ({ showAgentSnapshot, resetInputLine }) => {
		showAgentSnapshot()
		resetInputLine()
	},
	skills: openPanel({ type: CliPanelType.SKILLS }),
	usage: openPanel({ type: CliPanelType.USAGE }),
	clear: ({ clearViewAndResetTask }) => clearViewAndResetTask(),
	exit: ({ handleExit }) => handleExit(),
	q: ({ handleExit }) => handleExit(),
	quiet: ({ toggleQuietMode, resetInputLine }) => {
		toggleQuietMode()
		resetInputLine()
	},
	fast: ({ enableFastMode, resetInputLine }) => {
		enableFastMode()
		resetInputLine()
	},
	providers: openPanel({ type: CliPanelType.SETTINGS, initialMode: "provider-picker" }),
}

export function executeLocalSlashCommand(commandName: string, context: LocalSlashCommandContext): boolean {
	const handler = LOCAL_SLASH_COMMANDS[commandName]
	if (!handler) return false
	handler(context)
	return true
}

export function executeStandaloneLocalSlashCommand(text: string, context: LocalSlashCommandContext): boolean {
	const match = /^\s*\/([a-zA-Z0-9_.-]+)\s*$/.exec(text)
	if (!match) return false
	return executeLocalSlashCommand(match[1], context)
}

/**
 * Calculate visible window for a scrollable list menu.
 * Centers the selected item in the visible window when possible.
 * Returns the visible items and the start index for selection tracking.
 */
export function getVisibleWindow<T>(items: T[], selectedIndex: number, maxVisible = 5): VisibleWindow<T> {
	if (items.length <= maxVisible) {
		return { items, startIndex: 0 }
	}

	const halfWindow = Math.floor(maxVisible / 2)
	let startIndex = Math.max(0, selectedIndex - halfWindow)
	const endIndex = Math.min(items.length, startIndex + maxVisible)

	// Adjust if we're near the end
	if (endIndex - startIndex < maxVisible) {
		startIndex = Math.max(0, endIndex - maxVisible)
	}

	return { items: items.slice(startIndex, endIndex), startIndex }
}

/**
 * Sort commands with workflows (custom section) first, then default commands.
 */
export function sortCommandsWorkflowsFirst(commands: SlashCommandInfo[]): SlashCommandInfo[] {
	return [...commands.filter((cmd) => cmd.section === "custom"), ...commands.filter((cmd) => cmd.section !== "custom")]
}

export function mergeCliSlashCommands(
	localCommands: SlashCommandInfo[],
	backendCommands: SlashCommandInfo[],
): SlashCommandInfo[] {
	const localNames = new Set(localCommands.map((command) => command.name))
	const nonConflictingBackendCommands = backendCommands.filter((command) => !localNames.has(command.name))
	return [...localCommands, ...sortCommandsWorkflowsFirst(nonConflictingBackendCommands)]
}

/**
 * Extract slash command query from input text.
 * Returns info about whether we're in slash mode and what the query is.
 * Takes cursor position to only examine text before cursor (matching webview behavior).
 */
export function extractSlashQuery(text: string, cursorPosition?: number): SlashQueryInfo {
	// Use text up to cursor position (or full text if no cursor position provided)
	const beforeCursor = cursorPosition !== undefined ? text.slice(0, cursorPosition) : text

	// Find the last slash before cursor
	const slashIndex = beforeCursor.lastIndexOf("/")

	if (slashIndex === -1) {
		return { inSlashMode: false, query: "", slashIndex: -1 }
	}

	// Slash must be at start or preceded by whitespace
	const charBeforeSlash = slashIndex > 0 ? beforeCursor[slashIndex - 1] : null
	if (charBeforeSlash !== null && !/\s/.test(charBeforeSlash)) {
		return { inSlashMode: false, query: "", slashIndex: -1 }
	}

	// Get text after slash (up to cursor)
	const textAfterSlash = beforeCursor.slice(slashIndex + 1)

	// If there's whitespace after slash, we're not in slash mode anymore
	if (/\s/.test(textAfterSlash)) {
		return { inSlashMode: false, query: "", slashIndex: -1 }
	}

	// Check if there's already a completed slash command earlier in the text
	// (only first slash command per message is processed)
	const firstSlashCommandRegex = /(^|\s)\/[a-zA-Z0-9_.-]+\s/
	const textBeforeCurrentSlash = text.slice(0, slashIndex)
	if (firstSlashCommandRegex.test(textBeforeCurrentSlash)) {
		return { inSlashMode: false, query: "", slashIndex: -1 }
	}

	return {
		inSlashMode: true,
		query: textAfterSlash,
		slashIndex,
	}
}

/**
 * Filter commands using fuzzy matching
 */
export function filterCommands(commands: SlashCommandInfo[], query: string): SlashCommandInfo[] {
	if (!query) {
		return commands
	}
	return fuzzyFilter(commands, query, (cmd) => cmd.name)
}

/**
 * Insert a slash command at the given slash index, replacing any partial query
 */
export interface SlashCommandInsertion {
	text: string
	cursorPosition: number
}

export function insertSlashCommand(
	text: string,
	slashIndex: number,
	commandName: string,
	cursorPosition = text.length,
): SlashCommandInsertion {
	const beforeSlash = text.slice(0, slashIndex)
	const tokenEndOffset = text.slice(cursorPosition).search(/\s/)
	const tokenEnd = tokenEndOffset === -1 ? text.length : cursorPosition + tokenEndOffset
	const afterCommand = text.slice(tokenEnd).trimStart()
	const insertedCommand = `/${commandName} `
	return {
		text: beforeSlash + insertedCommand + afterCommand,
		cursorPosition: beforeSlash.length + insertedCommand.length,
	}
}
