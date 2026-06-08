/**
 * Tool-category color mapping.
 * Maps icon names to a semantic color for the category of tool.
 * Used by CardHeader to tint icons in collapsed cards.
 */
const ICON_CATEGORIES: Record<string, string> = {
    "file-text": "cyan",
    code: "cyan",
    edit: "cyan",
    search: "magenta",
    terminal: "green",
    eye: "blue",
    globe: "blue",
    cpu: "yellow",
}

export function getIconCategoryColor(iconName?: string): string | undefined {
    if (!iconName) return undefined
    return ICON_CATEGORIES[iconName]
}


export const ICON_MAP: Record<string, { emoji: string; unicode: string; ascii: string }> = {
    "file-text": { emoji: "📄", unicode: "┃", ascii: "FILE" },
    search: { emoji: "🔍", unicode: "⌕", ascii: "SEARCH" },
    terminal: { emoji: "💻", unicode: "⌘", ascii: "TERM" },
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
    "refresh-cw": { emoji: "🔄", unicode: "↻", ascii: "RELOAD" },
    "trash-2": { emoji: "🗑", unicode: "⌫", ascii: "DEL" },
    plus: { emoji: "➕", unicode: "+", ascii: "ADD" },
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
