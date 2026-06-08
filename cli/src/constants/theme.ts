/**
 * Semantic color palette for the Dirac CLI.
 * Single source of truth for all colors, enabling future --theme support.
 *
 * Two kinds of color values are exported:
 *   - ANSI codes  → used by display.ts (non-interactive / plain-text renderer)
 *   - Hex / Ink names → used by Ink components (interactive renderer)
 */

// ---------------------------------------------------------------------------
// ANSI escape codes (for plain-text / pipe mode)
// ---------------------------------------------------------------------------

export const ansi = {
    reset: "\x1b[0m",
    bold: "\x1b[1m",
    dim: "\x1b[2m",
    italic: "\x1b[3m",
    underline: "\x1b[4m",

    // Foreground
    black: "\x1b[30m",
    red: "\x1b[31m",
    green: "\x1b[32m",
    yellow: "\x1b[33m",
    blue: "\x1b[34m",
    magenta: "\x1b[35m",
    cyan: "\x1b[36m",
    white: "\x1b[37m",

    // Bright foreground
    brightBlack: "\x1b[90m",
    brightRed: "\x1b[91m",
    brightGreen: "\x1b[92m",
    brightYellow: "\x1b[93m",
    brightBlue: "\x1b[94m",
    brightMagenta: "\x1b[95m",
    brightCyan: "\x1b[96m",
    brightWhite: "\x1b[97m",

    // Background
    bgBlack: "\x1b[40m",
    bgRed: "\x1b[41m",
    bgGreen: "\x1b[42m",
    bgYellow: "\x1b[43m",
    bgBlue: "\x1b[44m",
    bgMagenta: "\x1b[45m",
    bgCyan: "\x1b[46m",
    bgWhite: "\x1b[47m",
} as const

// ---------------------------------------------------------------------------
// Semantic theme (Ink / hex values)
// ---------------------------------------------------------------------------

/**
 * Semantic color tokens (Ink names/hex).
 * Used by `styles` below and by components that need raw color values
 * for dynamic logic (e.g. threshold-based coloring).
 */
export const colors = {
    primary: "#B1B9F9",
    plan: "yellow",

    success: "green",
    error: "red",
    warning: "yellow",
    info: "cyan",
    muted: "gray",

    brightWhite: "brightWhite",
    brightBlack: "brightBlack",
    brightCyan: "brightCyan",
    blue: "blue",
    magenta: "magenta",
    gray: "gray",
    cyan: "cyan",

    // Inline code background (dark purple-gray, visible on dark terminals)
    codeBg: "#2a2a3e",
} as const

/**
 * Style recipes for Ink <Text> components.
 * Each entry is a spreadable props object: <Text {...styles.markdown.heading}>
 *
 * STATIC TOKENS ONLY — no logic. Dynamic rules (status → color, mode → tint)
 * live in the components that know the context.
 *
 * To experiment with the visual style, change values here.
 */
export const styles = {
    // --- Markdown / prose tokens (consumed by Markdown.tsx) ---
    markdown: {
        heading: { bold: true, color: "brightWhite" },
        headingSub: { bold: true },
        strong: { bold: true, color: "brightWhite" },
        emphasis: { italic: true },
        link: { color: "blue", underline: true },
        inlineCode: { color: "brightCyan", backgroundColor: "#2a2a3e" },
        codeBlock: { color: "brightCyan" },
        codeBorder: { color: "brightBlack" },
        blockquote: { dimColor: true },
        blockquoteBar: { color: "brightBlack" },
        tableBorder: { color: "brightBlack" },
        tableHeader: { bold: true },
        hr: { color: "gray" },
    },

    // --- Thinking indicator (consumed by ThinkingIndicator.tsx) ---
    thinking: {
        shimmerDim: { color: "gray", dimColor: true },
        shimmerBright: { color: "brightWhite", bold: true },
        elapsed: { color: "gray" },
        breadcrumb: { color: "gray", dimColor: true },
    },

    // --- Conversation markers (consumed by ChatMessage.tsx) ---
    conversation: {
        planModeTint: { color: "yellow" },
        completion: { color: "green", bold: true },
        divider: { color: "gray", dimColor: true },
        typeChangeSep: { color: "gray" },
    },
} as const


export const theme = {
    // Brand
    primary: "#B1B9F9",       // primaryBlue — act mode accent
    plan: "yellow",            // plan mode accent

    // Status (general)
    success: "green",
    error: "red",
    warning: "yellow",
    info: "cyan",
    muted: "gray",

    // Status (per CardStatus)
    status: {
        success: "green",
        error: "red",
        cancelled: "red",
        running: "blue",
        waiting: "magenta",
        building: "yellow",
        pending: "yellow",
        skipped: "gray",
        abandoned: "gray",
        default: "gray",
    },

    // Diff colors (Ink hex)
    diff: {
        addBg: "#080f0a",
        addFg: "#52C97A",
        removeBg: "#120707",
        removeFg: "#DD6B68",
        gutterFg: "#505866",
    },

    // UI elements
    separator: "gray",
    border: "gray",
    dimText: "gray",

    // Cost thresholds (dollars)
    costWarning: 1.0,
    costDanger: 5.0,

    // Context bar thresholds (0-1 ratio)
    contextWarning: 0.5,
    contextDanger: 0.8,
} as const

// ---------------------------------------------------------------------------
// ANSI → semantic helpers (for plain-text renderer)
// ---------------------------------------------------------------------------

/** Map a CardStatus to an ANSI color code. */
export function statusAnsi(status: string): string {
    switch (status) {
        case "success": return ansi.green
        case "error":
        case "cancelled": return ansi.red
        case "running": return ansi.blue
        case "waiting_for_input": return ansi.magenta
        case "building":
        case "pending": return ansi.yellow
        case "skipped":
        case "abandoned":
        default: return ansi.brightBlack
    }
}
