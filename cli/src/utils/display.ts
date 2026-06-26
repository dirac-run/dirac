/**
 * Non-interactive renderer for Dirac messages.
 * Handles ANSI-colored output for piped/redirected and plain-text modes.
 * For interactive rendering, see the Ink components in cli/src/components/.
 */

import { CardStatus, DiracMessageType } from "@shared/ExtensionMessage"
import type { DiracMessage, ExtensionState } from "@shared/ExtensionMessage"
import { originalConsoleError, originalConsoleLog } from "./console"

// ANSI color codes — re-exported from the centralized theme
import { ansi as colors } from "../constants/theme"
import { getIcon } from "./icon-mapping"

// Backward-compatible alias so existing code using `colors.xxx` keeps working
// const colors = ansi  // (already aliased in the import above)

/**
 * Center text by padding with spaces
 */
export function centerText(text: string, terminalWidth?: number): string {
	const width = terminalWidth || process.stdout.columns || 80
	const padding = Math.max(0, Math.floor((width - text.length) / 2))
	return " ".repeat(padding) + text
}

export function colorize(text: string, ...colorCodes: string[]): string {
	return colorCodes.join("") + text + colors.reset
}

// Helper functions for common color combinations
export const style = {
	bold: (text: string) => colorize(text, colors.bold),
	dim: (text: string) => colorize(text, colors.dim),
	italic: (text: string) => colorize(text, colors.italic),

	error: (text: string) => colorize(text, colors.red, colors.bold),
	warning: (text: string) => colorize(text, colors.yellow),
	success: (text: string) => colorize(text, colors.green),
	info: (text: string) => colorize(text, colors.cyan),

	// Message type colors
	task: (text: string) => colorize(text, colors.brightWhite, colors.bold),
	tool: (text: string) => colorize(text, colors.blue),
	command: (text: string) => colorize(text, colors.magenta),
	api: (text: string) => colorize(text, colors.brightBlack),
	user: (text: string) => colorize(text, colors.green),
	assistant: (text: string) => colorize(text, colors.cyan),

	// Special formatting
	path: (text: string) => colorize(text, colors.underline, colors.blue),
	code: (text: string) => colorize(text, colors.bgBlack, colors.brightWhite),
}

/**
 * Format a timestamp for display
 */
export function formatTimestamp(ts: number): string {
	const date = new Date(ts)
	return date.toLocaleTimeString("en-US", {
		hour12: false,
		hour: "2-digit",
		minute: "2-digit",
		second: "2-digit",
	})
}

function getMessageIcon(message: DiracMessage): string {
	const { content } = message

	switch (content.type) {
		case DiracMessageType.MARKDOWN:
			return content.isReasoning ? getIcon("cpu") : getIcon("message-square")
		case DiracMessageType.CARD: {
			const { card } = content
			if (card.icon) return card.icon
			if (card.requireApproval) return getIcon("terminal")
			if (card.requireFeedback) return getIcon("help-circle")
			if (card.status === CardStatus.SUCCESS) return getIcon("check-circle")
			if (card.status === CardStatus.ERROR) return getIcon("x-circle")
			return getIcon("settings")
		}
		case DiracMessageType.API_STATUS:
			return getIcon("refresh-cw")
		default:
			return "  "
	}
}

export function formatMessage(message: DiracMessage, verbose = false): string {
	const timestamp = formatTimestamp(message.ts)
	const icon = getMessageIcon(message)
	const prefix = `${style.dim(timestamp)} ${icon}`

	const { content } = message

	switch (content.type) {
		case DiracMessageType.MARKDOWN:
			return formatMarkdownMessage(message, prefix, verbose)
		case DiracMessageType.CARD:
			return formatCardMessage(message, prefix, verbose)
		case DiracMessageType.API_STATUS:
			return formatApiStatusMessage(message, prefix, verbose)
		default:
			return ""
	}
}

function formatMarkdownMessage(message: DiracMessage, prefix: string, verbose: boolean): string {
	if (message.content.type !== DiracMessageType.MARKDOWN) return ""
	const { content, isReasoning } = message.content

	if (isReasoning) {
		return `${prefix} ${style.dim("Thinking:")} ${style.italic(content)}`
	}

	return `${prefix} ${style.assistant(content)}`
}

function formatCardMessage(message: DiracMessage, prefix: string, verbose: boolean): string {
	if (message.content.type !== DiracMessageType.CARD) return ""
	const { card } = message.content

	const lines: string[] = []
	const headerStyle = card.status === CardStatus.ERROR ? style.error : style.tool
	const statusIndicator =
		card.status === CardStatus.SUCCESS ? style.success("✓ ") : card.status === CardStatus.ERROR ? style.error("✕ ") : ""
	const elapsed = card.startTime && card.endTime ? ` · ${((card.endTime - card.startTime) / 1000).toFixed(1)}s` : ""
	const outcome = card.outcome ? ` · ${card.outcome}` : ""
	const statusStr =
		card.status !== CardStatus.RUNNING && card.status !== CardStatus.SUCCESS && card.status !== CardStatus.ERROR
			? ` (${card.status})`
			: ""

	lines.push(`${prefix} ${statusIndicator}${headerStyle(card.header)}${statusStr}${outcome}${elapsed}`)

	if (card.body) {
		const body = card.body.trim()
		if (body) {
			const truncated = body.length > 1000 ? body.substring(0, 1000) + "..." : body
			lines.push(
				truncated
					.split("\n")
					.map((line) => `${" ".repeat(prefix.length + 1)}${style.dim(line)}`)
					.join("\n"),
			)
		}
	}

	if (card.requireApproval) {
		lines.push(`${" ".repeat(prefix.length + 1)}${style.warning("Approval required")}`)
	}

	if (card.requireFeedback) {
		lines.push(`${" ".repeat(prefix.length + 1)}${style.info("Feedback required")}`)
	}

	return lines.join("\n")
}

function formatApiStatusMessage(message: DiracMessage, prefix: string, verbose: boolean): string {
	if (message.content.type !== DiracMessageType.API_STATUS) return ""
	const { status } = message.content

	if (!verbose && !status.cost && !status.tokensIn) return ""

	const tokensStr =
		status.tokensIn !== undefined
			? `Tokens: ${status.tokensIn.toLocaleString()} in, ${status.tokensOut?.toLocaleString()} out${
					status.reasoningTokens ? ` (+${status.reasoningTokens.toLocaleString()} thinking)` : ""
				}`
			: ""

	const costStr = status.cost !== undefined ? `Cost: $${status.cost.toFixed(4)}` : ""

	const cacheStr =
		status.cacheReads !== undefined || status.cacheWrites !== undefined
			? ` (Cache: ${(status.cacheReads || 0).toLocaleString()} read, ${(status.cacheWrites || 0).toLocaleString()} write)`
			: ""

	const contextStr =
		status.contextWindow !== undefined
			? ` | Context: ${status.contextUsagePercentage}% of ${(status.contextWindow / 1000).toFixed(0)}K`
			: ""

	return `${prefix} ${style.api("API Status")} ${style.dim(`[${tokensStr}${cacheStr}${contextStr} | ${costStr}]`)}`
}

function getToolType(message: DiracMessage): string | null {
	if (message.content.type === DiracMessageType.CARD) {
		return message.content.card.header
	}
	return null
}

/**
 * Handle formatting of API request messages
 */

/**
 * Display a horizontal separator
 */
export function separator(char = "─", width = 60): string {
	return style.dim(char.repeat(width))
}

/**
 * Display the task header
 */
export function taskHeader(taskId: string, task?: string): string {
	const lines = [
		separator("═"),
		style.bold(`  Task: ${taskId}`),
		task ? `  ${style.dim(task.substring(0, 80))}${task.length > 80 ? "..." : ""}` : "",
		separator("═"),
	]
	return lines.filter(Boolean).join("\n")
}

/**
 * Format the current state for display
 */
export function formatState(state: ExtensionState, verbose = false): string {
	const lines: string[] = []

	if (state.currentTaskItem) {
		lines.push(taskHeader(state.currentTaskItem.id, state.currentTaskItem.task))
	}

	// Show messages
	if (state.diracMessages && state.diracMessages.length > 0) {
		const messagesToShow = verbose
			? state.diracMessages
			: state.diracMessages.filter((m) => {
					// Filter out noisy messages in non-verbose mode
					// if (m.say === "api_req_started" || m.say === "api_req_finished") return false
					return true
				})

		for (const message of messagesToShow) {
			const formatted = formatMessage(message, verbose)
			if (formatted) {
				lines.push(formatted)
			}
		}
	}

	return lines.join("\n")
}

/**
 * Display a spinner with message
 */
export class Spinner {
	private frames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"]
	private frameIndex = 0
	private interval: NodeJS.Timeout | null = null
	private message = ""

	start(message: string) {
		this.message = message
		this.interval = setInterval(() => {
			const frame = this.frames[this.frameIndex]
			process.stdout.write(`\r${style.info(frame)} ${this.message}`)
			this.frameIndex = (this.frameIndex + 1) % this.frames.length
		}, 80)
	}

	update(message: string) {
		this.message = message
	}

	stop(finalMessage?: string) {
		if (this.interval) {
			clearInterval(this.interval)
			this.interval = null
		}
		if (finalMessage) {
			process.stdout.write(`\r${style.success("✓")} ${finalMessage}\n`)
		} else {
			process.stdout.write("\r" + " ".repeat(this.message.length + 4) + "\r")
		}
	}

	fail(message?: string) {
		if (this.interval) {
			clearInterval(this.interval)
			this.interval = null
		}
		if (message) {
			process.stdout.write(`\r${style.error("✗")} ${message}\n`)
		}
	}
}

/**
 * Clear the current line
 */
export function clearLine() {
	process.stdout.write("\r\x1b[K")
}

/**
 * Move cursor up n lines
 */
export function cursorUp(n = 1) {
	process.stdout.write(`\x1b[${n}A`)
}

/**
 * Print a message to stdout with newline
 * Uses original console.log to work even when console is suppressed
 */
export function print(message: string) {
	originalConsoleLog(message)
}

/**
 * Print an error message to stderr
 * Uses original console.error to work even when console is suppressed
 */
export function printError(message: string) {
	originalConsoleError(style.error(message))
}

/**
 * Print a success message
 */
export function printSuccess(message: string) {
	originalConsoleLog(style.success(message))
}

/**
 * Print an info message
 */
export function printInfo(message: string) {
	originalConsoleLog(style.info(message))
}

/**
 * Print a warning message
 */
export function printWarning(message: string) {
	originalConsoleLog(style.warning(message))
}

/**
 * Prompt user for input from stdin
 */
export async function promptUser(question: string): Promise<string> {
	const readline = await import("readline")
	const rl = readline.createInterface({
		input: process.stdin,
		output: process.stdout,
	})

	return new Promise((resolve) => {
		rl.question(style.info(question) + " ", (answer: string) => {
			rl.close()
			resolve(answer.trim())
		})
	})
}

/**
 * Prompt user for yes/no confirmation
 */
export async function promptConfirmation(question: string): Promise<boolean> {
	const answer = await promptUser(`${question} ${style.dim("(y/n)")}`)
	return answer.toLowerCase() === "y" || answer.toLowerCase() === "yes"
}

/**
 * Create a progress bar for context window usage
 * Returns { filled, empty } strings to allow different coloring
 */
export function createContextBar(used: number, total: number, width = 8): { filled: string; empty: string } {
	const ratio = Math.min(used / total, 1)
	// Use ceil so any usage > 0 shows at least one bar
	const filledCount = used > 0 ? Math.max(1, Math.ceil(ratio * width)) : 0
	const emptyCount = width - filledCount
	return { filled: "█".repeat(filledCount), empty: "█".repeat(emptyCount) }
}

/**
 * Set the terminal session title using OSC escape sequence.
 * Works in most modern terminal emulators (iTerm2, Terminal.app, GNOME Terminal, etc.)
 */
export function setTerminalTitle(title: string): void {
	if (process.stdout.isTTY) {
		const maxLength = 80
		const truncated = title.length > maxLength ? title.slice(0, maxLength) + "..." : title
		process.stdout.write(`\x1b]0;${truncated}\x07`)
	}
}
