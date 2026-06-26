import fs from "node:fs"
import os from "node:os"
import path from "node:path"

export function jsonParseSafe<T>(data: string, defaultValue: T): T {
	try {
		return JSON.parse(data) as T
	} catch {
		return defaultValue
	}
}

const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp"])

/**
 * Check if a file path is an image based on extension
 */
export function isImagePath(filePath: string): boolean {
	const ext = path.extname(filePath).toLowerCase()
	return IMAGE_EXTENSIONS.has(ext)
}

/**
 * Get MIME type for an image extension
 */
function getMimeType(ext: string): string {
	const mimeTypes: Record<string, string> = {
		".png": "image/png",
		".jpg": "image/jpeg",
		".jpeg": "image/jpeg",
		".gif": "image/gif",
		".webp": "image/webp",
	}
	return mimeTypes[ext.toLowerCase()] || "image/png"
}

/**
 * Convert an image file path to a base64 data URL
 */
export async function imageFileToDataUrl(filePath: string): Promise<string> {
	const resolvedPath = path.resolve(filePath)
	const ext = path.extname(resolvedPath).toLowerCase()
	const mimeType = getMimeType(ext)

	const buffer = await fs.promises.readFile(resolvedPath)
	const base64 = buffer.toString("base64")

	return `data:${mimeType};base64,${base64}`
}

/**
 * Parse input text and extract image file paths.
 * Supports formats like: "prompt text @/path/to/image.png" or just file paths
 * Returns the clean prompt text and array of image paths
 */
/**
 * Expand ~ to home directory
 */
function expandHome(p: string): string {
	if (p.startsWith("~/") || p === "~") {
		return path.join(os.homedir(), p.slice(1))
	}
	return p
}

/**
 * Check if a path exists on disk (handles unescaping and home expansion)
 */
function fileExists(p: string): boolean {
	try {
		const unescaped = unescapePath(p)
		const expanded = expandHome(unescaped)
		const resolved = path.resolve(expanded)
		return fs.existsSync(resolved)
	} catch {
		return false
	}
}

function unescapePath(p: string): string {
	if ((p.startsWith('"') && p.endsWith('"')) || (p.startsWith("'") && p.endsWith("'"))) {
		return p.slice(1, -1)
	}
	// Handle backslash-escaped spaces and other common terminal escapes
	return p.replace(/\\(.)/g, "$1")
}

export function parseImagesFromInput(input: string): { prompt: string; imagePaths: string[] } {
	const imagePaths: string[] = []

	// Match @path/to/image.ext patterns (with space or at start)
	// Supports: @/abs/path, @./rel/path, @path/to/file, @C:\path\to\file, @~/path
	// Also supports quoted paths and escaped spaces
	const atPathPattern =
		/@(?:"([^"]+\.(?:png|jpg|jpeg|gif|webp))"|'([^']+\.(?:png|jpg|jpeg|gif|webp))'|((?:[a-zA-Z]:\\|\/|\.\/|\.\.\/|~|[^\s@])(?:[^\s]|\\ )*?\.(?:png|jpg|jpeg|gif|webp)))/gi

	// Match standalone paths that look like images
	// Stricter for unquoted paths: must start with /, ./, ../, ~/, or drive letter
	const standalonePathPattern =
		/(?:^|[ \t\n\r\f\v])(?:"([^"]+\.(?:png|jpg|jpeg|gif|webp))"|'([^']+\.(?:png|jpg|jpeg|gif|webp))'|((?:[a-zA-Z]:\\|\/|\.\/|\.\.\/|~)(?:[^ \t\n\r\f\v]|\\ )*?\.(?:png|jpg|jpeg|gif|webp)))(?=[ \t\n\r\f\v]|$)/gi

	let match: RegExpExecArray | null

	// First pass: find all potential image paths that actually exist
	while ((match = atPathPattern.exec(input)) !== null) {
		const p = match[1] || match[2] || match[3]
		if (p && fileExists(p)) {
			const unescaped = unescapePath(p)
			if (!imagePaths.includes(unescaped)) {
				imagePaths.push(unescaped)
			}
		}
	}

	while ((match = standalonePathPattern.exec(input)) !== null) {
		const p = match[1] || match[2] || match[3]
		if (p && fileExists(p)) {
			const unescaped = unescapePath(p)
			if (!imagePaths.includes(unescaped)) {
				imagePaths.push(unescaped)
			}
		}
	}

	// Second pass: only remove paths from the prompt if they were successfully matched and exist
	const prompt = input
		.replace(atPathPattern, (match, p1, p2, p3) => {
			const p = p1 || p2 || p3
			return p && fileExists(p) ? " " : match
		})
		.replace(standalonePathPattern, (match, p1, p2, p3) => {
			const p = p1 || p2 || p3
			// For standalone paths, we need to preserve the leading separator if it was part of the match
			const prefix = match.match(/^[ \t\n\r\f\v]/) ? match[0] : ""
			return p && fileExists(p) ? prefix + " " : match
		})
		.replace(/[ \t]+/g, " ")
		.trim()

	return { prompt, imagePaths }
}

/**
 * Parse headers string into a Record<string, string>.
 * Supports comma-separated key=value pairs or JSON.
 * Example: "X-Header=Value,Authorization=Bearer token" or '{"X-Header": "Value"}'
 */
export function parseHeaders(headersString: string): Record<string, string> {
	const trimmed = headersString.trim()
	if (trimmed.startsWith("{")) {
		try {
			return JSON.parse(trimmed)
		} catch (error) {
			// Fall back to comma-separated if JSON parsing fails
		}
	}

	const headers: Record<string, string> = {}
	const pairs = trimmed.split(",")
	for (const pair of pairs) {
		const [key, ...valueParts] = pair.split("=")
		if (key && valueParts.length > 0) {
			headers[key.trim()] = valueParts.join("=").trim()
		}
	}
	return headers
}

/**
 * Process image file paths into base64 data URLs
 * Returns only successfully converted images
 */
export async function processImagePaths(imagePaths: string[]): Promise<string[]> {
	const dataUrls: string[] = []

	for (const imagePath of imagePaths) {
		try {
			const expandedPath = expandHome(imagePath)
			const resolvedPath = path.resolve(expandedPath)
			if (fs.existsSync(resolvedPath) && isImagePath(resolvedPath)) {
				const dataUrl = await imageFileToDataUrl(resolvedPath)
				dataUrls.push(dataUrl)
			}
		} catch {
			// Skip files that can't be read
		}
	}

	return dataUrls
}
