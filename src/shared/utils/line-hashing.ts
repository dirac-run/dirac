/**
 * Shared utility for hash-anchored line protocol.
 * Used by both the extension (to generate/reconcile hashes) and the webview (to strip hashes for display).
 */

export const ANCHOR_DELIMITER = "§"

/**
 * Returns the centralized delimiter used to separate anchors from content.
 *
 * @returns The anchor delimiter string
 */
export function getDelimiter(): string {
	return ANCHOR_DELIMITER
}

/**
 * Removes a hash anchor prefix from a line when the line starts with one.
 */
function stripAnchorPrefix(line: string, offset = 0): string {
	const delimiterIndex = line.indexOf(ANCHOR_DELIMITER, offset)
	if (delimiterIndex === -1) {
		return line
	}

	const prefix = line.substring(offset, delimiterIndex)
	if (!/^[A-Z][a-zA-Z]*$/.test(prefix)) {
		return line
	}

	return line.substring(0, offset) + line.substring(delimiterIndex + ANCHOR_DELIMITER.length)
}

/**
 * Strips hash prefixes from raw content.
 * Only removes a prefix when the line starts directly with an anchor word followed by the delimiter.
 * Interior anchors and indented anchor-like literals are preserved exactly.
 *
 * @param content - The content containing hashed lines
 * @returns The clean content without line-start hashes
 */
export function stripHashes(content: string): string {
	if (!content) {
		return ""
	}

	return content
		.split("\n")
		.map((line) => stripAnchorPrefix(line))
		.join("\n")
}

/**
 * Strips hash prefixes from diff-formatted content.
 * Preserves a leading diff marker (+, -, or space) and removes an anchor immediately after it.
 * Lines without a diff marker use the same behavior as stripHashes.
 *
 * @param content - The diff content containing hashed lines
 * @returns The clean diff content without anchor prefixes
 */
export function stripHashesFromDiff(content: string): string {
	if (!content) {
		return ""
	}

	return content
		.split("\n")
		.map((line) => {
			if (line.length > 0 && (line[0] === "+" || line[0] === "-" || line[0] === " ")) {
				return stripAnchorPrefix(line, 1)
			}

			return stripAnchorPrefix(line)
		})
		.join("\n")
}

/**
 * Extracts the ID from a line reference provided by the model.
 * Handles both "ID" and "ID:CONTENT" formats.
 *
 * @param ref - The line reference string
 * @returns The extracted ID
 */
export function extractId(ref: string): string {
	if (!ref) {
		return ""
	}
	const delimiterIndex = ref.indexOf(ANCHOR_DELIMITER)
	return delimiterIndex === -1 ? ref : ref.substring(0, delimiterIndex)
}
