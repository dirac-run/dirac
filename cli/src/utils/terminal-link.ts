import path from "node:path"
import { PATH_REGEX, extractFirstPath } from "@shared/string"


/**
 * Wraps text in OSC 8 escape sequences to create a terminal link.
 */
export function terminalLink(text: string, url: string): string {
	return `\u001b]8;;${url}\u001b\\${text}\u001b]8;;\u001b\\`
}

/**
 * Detects file paths in a string and wraps them with terminal links.
 */
export function linkifyPaths(text: string | undefined): string {
	if (!text) return ""

	return text.replace(PATH_REGEX, (match) => {
		// Avoid version numbers (e.g., v1.2.3)
		if (/^v?\d+(\.\d+)+$/.test(match)) return match
		// Avoid IP addresses
		if (/^\d{1,3}(\.\d{1,3}){3}$/.test(match)) return match
		// Avoid things that are already URLs
		if (match.includes("://")) return match

		try {
			const url = getPathUrl(match)
			return terminalLink(match, url)
		} catch {
			return match
		}
	})
}

/**
 * Resolves a file path to an absolute file:// URL.
 */
export function getPathUrl(filePath: string): string {
	const cwd = process.cwd()
	let absolutePath = filePath
	if (!path.isAbsolute(filePath)) {
		absolutePath = path.resolve(cwd, filePath)
	}
	// Use file:// URL with forward slashes (required for some terminals)
	return `file://${absolutePath.replace(/\\/g, "/")}`
}

export { extractFirstPath }

