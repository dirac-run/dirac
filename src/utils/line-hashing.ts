import { AnchorStateManager } from "./AnchorStateManager"

export { ANCHOR_DELIMITER, extractId, getDelimiter, stripHashes, stripHashesFromDiff } from "../shared/utils/line-hashing"

/**
 * Generates a 32-bit hash for the given content string.
 * Uses FNV-1a algorithm for high performance.
 *
 * @param content - The text content to hash
 * @returns An 8-character hex string representing the hash
 */
export function contentHash(content: string): string {
	let h = 2166136261 // FNV-1a offset basis
	for (let i = 0; i < content.length; i++) {
		h = Math.imul(h ^ content.charCodeAt(i), 16777619) // FNV-1a prime
	}
	return (h >>> 0).toString(16).padStart(8, "0")
}

/**
 * Formats a single line with its hash prefix.
 *
 * @param content - The text content of the line
 * @param anchor - The pre-calculated anchor for this line
 * @returns The formatted string in "ID:CONTENT" format
 */

/**
 * Splits a raw anchor string into its anchor word and content parts.
 *
 * @param rawAnchor - The raw anchor string (e.g., "    def process(data):")
 * @returns An object containing the anchor word and the content part
 */
export function splitAnchor(rawAnchor: string): { anchor: string; content: string } {
	const delimiterIndex = rawAnchor.indexOf(ANCHOR_DELIMITER)
	if (delimiterIndex === -1) {
		return { anchor: rawAnchor.trim(), content: "" }
	}
	return {
		anchor: rawAnchor.substring(0, delimiterIndex).trim(),
		content: rawAnchor.substring(delimiterIndex + ANCHOR_DELIMITER.length),
	}
}

import { ANCHOR_DELIMITER } from "../shared/utils/line-hashing"
export function formatLineWithHash(content: string, anchor: string): string {
	return `${anchor}${ANCHOR_DELIMITER}${content}`
}

/**
 * Hashes all lines in a given content string using the stateful anchor manager.
 *
 * @param absolutePath - The absolute path of the file being hashed
 * @param content - The full text content to hash
 * @param taskId - The unique ID of the task for scoping anchors
 * @returns The content with each line prefixed by its stateful anchor
 */
export function hashLinesStateful(absolutePath: string, content: string, taskId?: string): string {
	if (!content) {
		return ""
	}

	const lines = content.split(/\r?\n/)
	const anchors = AnchorStateManager.reconcile(absolutePath, lines, taskId)

	return lines.map((line, index) => formatLineWithHash(line, anchors[index])).join("\n")
}

/**
 * Formats a single line for model consumption, conditionally including anchors.
 *
 * @param content - The text content of the line
 * @param anchor - The pre-calculated anchor for this line
 * @param includeAnchors - Whether to include the anchor prefix
 * @returns The formatted string
 */
export function formatLineForModel(content: string, anchor: string, includeAnchors: boolean): string {
	return includeAnchors ? formatLineWithHash(content, anchor) : content
}

/**
 * Formats multiple lines for model consumption, conditionally including anchors.
 *
 * @param lines - The text content of each line
 * @param anchors - The pre-calculated anchors for each line
 * @param includeAnchors - Whether to include anchor prefixes
 * @returns The formatted multi-line string
 */
export function formatLinesForModel(lines: string[], anchors: string[], includeAnchors: boolean): string {
	return lines.map((line, index) => formatLineForModel(line, anchors[index], includeAnchors)).join("\n")
}

/**
 * Legacy wrapper for hashLines. Now requires absolutePath for stateful hashing.
 * If absolutePath is not provided, it will return the content as-is (with no anchors).
 *
 * @param content - The text content to hash
 * @param absolutePath - The absolute path of the file (required for stateful hashing)
 * @param taskId - The unique ID of the task for scoping anchors
 * @returns The content with each line prefixed by its hash
 */
export function hashLines(content: string, absolutePath?: string, taskId?: string): string {
	if (!content) {
		return ""
	}

	if (!absolutePath) {
		return content
	}

	return hashLinesStateful(absolutePath, content, taskId)
}
