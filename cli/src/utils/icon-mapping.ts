export const ICON_MAP: Record<string, { emoji: string; ascii: string }> = {
	"file-text": { emoji: "📄", ascii: "FILE" },
	search: { emoji: "🔍", ascii: "SEARCH" },
	terminal: { emoji: "💻", ascii: "TERM" },
	code: { emoji: "📝", ascii: "CODE" },
	folder: { emoji: "📁", ascii: "DIR" },
	check: { emoji: "✔", ascii: "OK" },
	"alert-triangle": { emoji: "⚠", ascii: "WARN" },
	info: { emoji: "ℹ", ascii: "INFO" },
	"help-circle": { emoji: "❓", ascii: "HELP" },
	"message-square": { emoji: "💬", ascii: "MSG" },
	eye: { emoji: "👁", ascii: "VIEW" },
	play: { emoji: "▶", ascii: "RUN" },
	"stop-circle": { emoji: "🛑", ascii: "STOP" },
	"refresh-cw": { emoji: "🔄", ascii: "RELOAD" },
	"trash-2": { emoji: "🗑", ascii: "DEL" },
	plus: { emoji: "➕", ascii: "ADD" },
	edit: { emoji: "✏", ascii: "EDIT" },
	"external-link": { emoji: "🔗", ascii: "LINK" },
	settings: { emoji: "⚙", ascii: "SET" },
	user: { emoji: "👤", ascii: "USER" },
	cpu: { emoji: "🧠", ascii: "CPU" },
	globe: { emoji: "🌐", ascii: "WEB" },
	"chevron-right": { emoji: "›", ascii: ">" },
	"chevron-down": { emoji: "⌄", ascii: "v" },
	"check-circle": { emoji: "✔", ascii: "DONE" },
	"x-circle": { emoji: "✖", ascii: "FAIL" },
	fast_forward: { emoji: "⏭", ascii: "SKIP" },
	ghost: { emoji: "👻", ascii: "GHOST" },
}

export const DEFAULT_ICON = { emoji: "🔧", ascii: "TOOL" }

export function getIcon(name?: string, useEmoji = true): string {
	if (!name) return useEmoji ? DEFAULT_ICON.emoji : DEFAULT_ICON.ascii
	const icon = ICON_MAP[name] || DEFAULT_ICON
	return useEmoji ? icon.emoji : icon.ascii
}


export function getStatusIcon(status: string): string {
	switch (status) {
		case "building":
		case "pending":
			return "⋯"
		case "running":
			return "⠋"
		case "success":
			return "✓"
		case "error":
			return "✕"
		case "skipped":
			return "↷"
		case "cancelled":
			return "⊘"
		case "abandoned":
			return "👻"
		case "waiting_for_input":
			return "⍰"
		default:
			return "•"
	}
}

export function getStatusColor(status: string): string {
	switch (status) {
		case "success":
			return "green"
		case "error":
		case "cancelled":
			return "red"
		case "running":
			return "blue"
		case "waiting_for_input":
			return "magenta"
		case "building":
		case "pending":
			return "yellow"
		case "skipped":
		case "abandoned":
		default:
			return "gray"
	}
}
