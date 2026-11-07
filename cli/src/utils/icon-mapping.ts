/**
 * Terminal icon and color mapping for tool cards. Tool category communicates
 * what is happening; status color communicates how it is going.
 */
import { CardStatus } from "@shared/ExtensionMessage"
import { theme } from "../constants/theme"

export function getIconCategoryColor(iconName?: string): string {
	if (!iconName) return theme.toolCommunicate
	const iconCategories: Record<string, string> = {
		"book-open-check": theme.toolRead,
		"file-text": theme.toolRead,
		"folder-tree": theme.toolRead,
		folder: theme.toolRead,
		"file-pen-line": theme.toolEdit,
		"file-plus-2": theme.toolEdit,
		"arrow-right-left": theme.toolEdit,
		edit: theme.toolEdit,
		code: theme.toolEdit,
		component: theme.toolSearch,
		"square-function": theme.toolSearch,
		"list-tree": theme.toolSearch,
		search: theme.toolSearch,
		terminal: theme.toolExecute,
		play: theme.toolExecute,
		"shield-check": theme.toolDiagnostic,
		bug: theme.toolDiagnostic,
		eye: theme.toolInspect,
		globe: theme.toolInspect,
		users: theme.toolCommunicate,
		"clipboard-list": theme.toolCommunicate,
		"message-square": theme.toolCommunicate,
		"message-square-quote": theme.toolCommunicate,
		map: theme.plan,
		zap: theme.toolExecute,
		"check-circle": theme.toolComplete,
		"check-circle-2": theme.toolComplete,
	}
	return iconCategories[iconName] ?? theme.toolCommunicate
}

export const ICON_MAP: Record<string, { emoji: string; unicode: string; ascii: string }> = {
	"book-open-check": { emoji: "📖", unicode: "▤", ascii: "READ" },
	"file-text": { emoji: "📄", unicode: "┃", ascii: "FILE" },
	"file-pen-line": { emoji: "📝", unicode: "✎", ascii: "EDIT" },
	"file-plus-2": { emoji: "📄", unicode: "+", ascii: "WRITE" },
	"arrow-right-left": { emoji: "⇄", unicode: "⇄", ascii: "SWAP" },
	component: { emoji: "◈", unicode: "◈", ascii: "SYMBOL" },
	"square-function": { emoji: "ƒ", unicode: "ƒ", ascii: "FUNC" },
	"list-tree": { emoji: "☷", unicode: "☷", ascii: "TREE" },
	"folder-tree": { emoji: "📂", unicode: "▸", ascii: "FILES" },
	search: { emoji: "🔍", unicode: "⌕", ascii: "SEARCH" },
	terminal: { emoji: "💻", unicode: "⌘", ascii: "TERM" },
	"shield-check": { emoji: "🛡", unicode: "◇", ascii: "CHECK" },
	users: { emoji: "♟", unicode: "♟", ascii: "AGENTS" },
	"clipboard-list": { emoji: "📋", unicode: "☷", ascii: "SUMMARY" },
	"message-square-quote": { emoji: "❝", unicode: "❝", ascii: "ASK" },
	"check-circle-2": { emoji: "✔", unicode: "✓", ascii: "DONE" },
	bug: { emoji: "🐞", unicode: "◆", ascii: "BUG" },
	map: { emoji: "🗺", unicode: "◇", ascii: "PLAN" },
	zap: { emoji: "⚡", unicode: "ϟ", ascii: "SKILL" },
	code: { emoji: "📝", unicode: "✎", ascii: "CODE" },
	folder: { emoji: "📁", unicode: "▸", ascii: "DIR" },
	check: { emoji: "✔", unicode: "✓", ascii: "OK" },
	"alert-triangle": { emoji: "⚠", unicode: "⚠", ascii: "WARN" },
	info: { emoji: "ℹ", unicode: "ℹ", ascii: "INFO" },
	"help-circle": { emoji: "❓", unicode: "?", ascii: "HELP" },
	"message-square": { emoji: "💬", unicode: "❯", ascii: "MSG" },
	eye: { emoji: "👁", unicode: "◉", ascii: "VIEW" },
	play: { emoji: "▶", unicode: "▶", ascii: "RUN" },
	"stop-circle": { emoji: "🛑", unicode: "■", ascii: "STOP" },
	clock: { emoji: "◷", unicode: "◷", ascii: "WAIT" },
	"refresh-cw": { emoji: "🔄", unicode: "↻", ascii: "RELOAD" },
	"trash-2": { emoji: "🗑", unicode: "⌫", ascii: "DEL" },
	plus: { emoji: "+", unicode: "+", ascii: "ADD" },
	edit: { emoji: "✏", unicode: "✎", ascii: "EDIT" },
	"external-link": { emoji: "🔗", unicode: "⤴", ascii: "LINK" },
	settings: { emoji: "⚙", unicode: "⚙", ascii: "SET" },
	user: { emoji: "👤", unicode: "◇", ascii: "USER" },
	cpu: { emoji: "🧠", unicode: "◆", ascii: "CPU" },
	globe: { emoji: "🌐", unicode: "⊕", ascii: "WEB" },
	"chevron-right": { emoji: "›", unicode: "›", ascii: ">" },
	"chevron-down": { emoji: "⌄", unicode: "⌄", ascii: "v" },
	"check-circle": { emoji: "✔", unicode: "✓", ascii: "DONE" },
	"x-circle": { emoji: "✖", unicode: "✕", ascii: "FAIL" },
	fast_forward: { emoji: "⏭", unicode: "⏭", ascii: "SKIP" },
	ghost: { emoji: "👻", unicode: "◌", ascii: "GHOST" },
}

export const DEFAULT_ICON = { emoji: "🔧", unicode: "⚙", ascii: "TOOL" }

export type IconMode = "emoji" | "unicode" | "ascii"

/** Global override: set via CLI --no-emoji flag or DIRAC_NO_EMOJI env var. */
let _forceIconMode: IconMode | null = null

export function setIconMode(mode: IconMode | null): void {
	_forceIconMode = mode
}

export function getIcon(name?: string, mode?: IconMode): string {
	const effectiveMode = mode ?? _forceIconMode ?? "emoji"
	if (!name) return DEFAULT_ICON[effectiveMode]
	const icon = ICON_MAP[name] || DEFAULT_ICON
	return icon[effectiveMode]
}

export function getStatusIcon(status: CardStatus): string {
	switch (status) {
		case CardStatus.BUILDING:
		case CardStatus.PENDING:
			return "⋯"
		case CardStatus.RUNNING:
			return "⠋"
		case CardStatus.SUCCESS:
			return "✓"
		case CardStatus.ERROR:
			return "✕"
		case CardStatus.SKIPPED:
			return "↷"
		case CardStatus.CANCELLED:
			return "⊘"
		case CardStatus.ABANDONED:
			return "◌"
		case CardStatus.WAITING_FOR_INPUT:
			return "?"
	}
}

export function getStatusColor(status: CardStatus): string {
	switch (status) {
		case CardStatus.SUCCESS:
			return theme.status.success
		case CardStatus.ERROR:
			return theme.status.error
		case CardStatus.CANCELLED:
			return theme.status.cancelled
		case CardStatus.RUNNING:
			return theme.status.running
		case CardStatus.WAITING_FOR_INPUT:
			return theme.status.waiting
		case CardStatus.BUILDING:
			return theme.status.building
		case CardStatus.PENDING:
			return theme.status.pending
		case CardStatus.SKIPPED:
			return theme.status.skipped
		case CardStatus.ABANDONED:
			return theme.status.abandoned
	}
}
