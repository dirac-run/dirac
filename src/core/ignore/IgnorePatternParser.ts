import { fileExistsAtPath } from "@utils/fs"
import fs from "fs/promises"
import path from "path"
import { Logger } from "@/shared/services/Logger"
import { INCLUDE_PREFIX } from "./IgnorePatterns"

/**
 * Parses .diracignore content, resolving "!include <file>" directives by inlining
 * the referenced files' contents. Returns the combined ignore-pattern text ready
 * to be fed to an `ignore` instance.
 */
export async function parseIgnoreContent(content: string, cwd: string): Promise<string> {
	// Optimization: skip include processing when there are no directives
	if (!content.includes(INCLUDE_PREFIX)) {
		return content
	}
	const lines = content.split(/\r?\n/)
	const resolved = await Promise.all(lines.map((line) => resolveIncludeLine(line, cwd)))
	return resolved.join("\n")
}

// Passthrough for plain pattern lines; inlines content for !include directives
async function resolveIncludeLine(line: string, cwd: string): Promise<string> {
	const trimmedLine = line.trim()
	if (!trimmedLine.startsWith(INCLUDE_PREFIX)) {
		return line
	}
	const includedContent = await readIncludedFile(trimmedLine, cwd)
	return includedContent ?? ""
}

async function readIncludedFile(includeLine: string, cwd: string): Promise<string | null> {
	const includePath = includeLine.substring(INCLUDE_PREFIX.length).trim()
	const resolvedIncludePath = path.join(cwd, includePath)

	if (!(await fileExistsAtPath(resolvedIncludePath))) {
		Logger.debug(`[DiracIgnore] Included file not found: ${resolvedIncludePath}`)
		return null
	}

	return await fs.readFile(resolvedIncludePath, "utf8")
}
