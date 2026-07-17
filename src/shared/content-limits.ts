/**
 * Content size limits to prevent massive files/responses from bricking conversations.
 * 400KB ≈ ~100,000 tokens, which is a reasonable limit for context.
 */

/** Maximum content size in bytes (400KB) */
export const MAX_CONTENT_SIZE_BYTES = 400 * 1024

/**
 * Format bytes into a human-readable string (e.g., "1.5 MB", "400 KB").
 */
export function formatBytes(bytes: number): string {
	if (bytes < 1024) {
		return `${bytes} B`
	}
	if (bytes < 1024 * 1024) {
		return `${(bytes / 1024).toFixed(1)} KB`
	}
	return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

/**
 * Truncate content if it exceeds the maximum size limit.
 * Shows the beginning of the content with a clear truncation notice at the very end.
 *
 * @param content The content to potentially truncate
 * @param maxSize Maximum size in bytes (defaults to MAX_CONTENT_SIZE_BYTES)
 * @returns The original content if under limit, or truncated content with message at end
 */
/**
 * Truncate content using a head/tail approach if it exceeds the maximum size limit.
 * Keeps the beginning and the end of the content, with a truncation notice in the middle.
 *
 * @param content The content to potentially truncate
 * @param maxSize Maximum size in bytes (defaults to MAX_CONTENT_SIZE_BYTES)
 * @returns The original content if under limit, or head/tail truncated content with message in middle
 */
export function truncateHeadTail(content: string, maxSize: number = MAX_CONTENT_SIZE_BYTES): string {
	const contentBuffer = Buffer.from(content, "utf8")
	if (contentBuffer.byteLength <= maxSize) {
		return content
	}
	if (maxSize <= 0) {
		return ""
	}

	const initiallyTruncatedBytes = contentBuffer.byteLength - maxSize
	const notice = `\n\n... [Output truncated to ${formatBytes(maxSize)} to avoid context flooding (${formatBytes(initiallyTruncatedBytes)} truncated). Use more specific commands if you need to see more output.] ...\n\n`
	const noticeBytes = Buffer.byteLength(notice, "utf8")
	if (noticeBytes >= maxSize) {
		return Buffer.from(notice, "utf8").subarray(0, maxSize).toString("utf8").replace(/\uFFFD$/, "")
	}

	const contentBudget = maxSize - noticeBytes
	const headBytes = Math.floor(contentBudget / 2)
	const tailBytes = contentBudget - headBytes
	const start = contentBuffer.subarray(0, headBytes).toString("utf8").replace(/\uFFFD$/, "")
	const end = contentBuffer
		.subarray(contentBuffer.byteLength - tailBytes)
		.toString("utf8")
		.replace(/^\uFFFD/, "")

	return `${start}${notice}${end}`
}

export function truncateContent(content: string, maxSize: number = MAX_CONTENT_SIZE_BYTES): string {
	const contentBuffer = Buffer.from(content, "utf8")
	if (contentBuffer.byteLength <= maxSize) {
		return content
	}

	const truncatedContent = contentBuffer.subarray(0, maxSize).toString("utf8").replace(/\uFFFD$/, "")
	const truncatedAmount = contentBuffer.byteLength - maxSize

	return `${truncatedContent}

---

[FILE TRUNCATED: This content is ${formatBytes(contentBuffer.byteLength)} but only the first ${formatBytes(maxSize)} is shown (${formatBytes(truncatedAmount)} truncated). Use search_files to find specific patterns, or execute_command with grep/head/tail for targeted reading.]`
}
