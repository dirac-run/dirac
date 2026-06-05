import { DiracIgnoreController } from "@core/ignore/DiracIgnoreController"
import { AnchorStateManager } from "@utils/AnchorStateManager"
import { formatLineWithHash } from "@utils/line-hashing"
import * as childProcess from "child_process"
import * as fs from "fs/promises"
import * as path from "path"
import * as readline from "readline"
import { Logger } from "@/shared/services/Logger"
import { getBinaryLocation } from "@/utils/fs"

/*
This file provides functionality to perform regex searches on files using ripgrep.
Inspired by: https://github.com/DiscreteTom/vscode-ripgrep-utils

Key components:
* execRipgrep: Executes the ripgrep command and returns the output.
* regexSearchFiles: The main function that performs regex searches on files.
   - Parameters:
     * cwd: The current working directory (for relative path calculation)
     * directoryPath: The directory to search in
     * regex: The regular expression to search for (Rust regex syntax)
     * filePattern: Optional glob pattern to filter files (default: '*')
   - Returns: A formatted string containing search results with context

The search results include:
- Relative file paths
- 2 lines of context before and after each match
- Matches formatted with pipe characters for easy reading

Usage example:
const results = await regexSearchFiles('/path/to/cwd', '/path/to/search', 'TODO:', '*.ts');

rel/path/to/app.ts
│----
│function processData(data: any) {
│  // Some processing logic here
│  // TODO: Implement error handling
│  return processedData;
│}
│----

rel/path/to/helper.ts
│----
│  let result = 0;
│  for (let i = 0; i < input; i++) {
│    // TODO: Optimize this function for performance
│    result += Math.pow(i, 2);
│  }
│----
*/

interface SearchResultLine {
	lineNum: number
	content: string
	isMatch: boolean
	column?: number
}

interface FileSearchResult {
	filePath: string
	lines: SearchResultLine[]
}

const MAX_RESULTS = 30

type RipgrepDebugLog = (info: Record<string, any>) => Promise<void>

async function execRipgrep(args: string[], debugLog?: RipgrepDebugLog): Promise<string> {
	const binPath: string = await getBinaryLocation("rg")
	await debugLog?.({ info: "execRipgrep start", binPath, args })

	return new Promise((resolve, reject) => {
		const rgProcess = childProcess.spawn(binPath, args)
		// cross-platform alternative to head, which is ripgrep author's recommendation for limiting output.
		const rl = readline.createInterface({
			input: rgProcess.stdout,
			crlfDelay: Number.POSITIVE_INFINITY, // treat \r\n as a single line break even if it's split across chunks. This ensures consistent behavior across different operating systems.
		})

		let output = ""
		let lineCount = 0
		const maxLines = MAX_RESULTS * 5 // limiting ripgrep output with max lines since there's no other way to limit results. it's okay that we're outputting as json, since we're parsing it line by line and ignore anything that's not part of a match. This assumes each result is at most 5 lines.

		rl.on("line", (line) => {
			if (lineCount < maxLines) {
				output += line + "\n"
				lineCount++
			} else {
				rl.close()
				rgProcess.kill()
			}
		})

		let errorOutput = ""
		rgProcess.stderr.on("data", (data) => {
			errorOutput += data.toString()
		})
		rl.on("close", () => {
			const finishDetails = {
				info: "execRipgrep finished",
				lineCount,
				stderrOutput: errorOutput || "(none)",
				outputLength: output.length,
				outputPreview: output.substring(0, 300),
			}
			void debugLog?.(finishDetails)
			if (errorOutput) {
				reject(new Error(`ripgrep process error: ${errorOutput}`))
			} else {
				resolve(output)
			}
		})
		rgProcess.on("error", (error) => {
			void debugLog?.({
				info: "execRipgrep process error",
				errorMessage: error.message,
				stack: error.stack,
			})
			reject(new Error(`ripgrep process error: ${error.message}`))
		})
	})
}

export async function regexSearchFiles(
	cwd: string,
	directoryPath: string,
	regex: string,
	filePattern?: string,
	diracIgnoreController?: DiracIgnoreController,
	taskId?: string,
	contextLines?: number,
	excludeFilePatterns?: string[],
	debugLog?: RipgrepDebugLog,
): Promise<string> {
	// Limit context lines to 10
	const cappedContextLines = Math.max(0, Math.min(10, contextLines || 0))
	const args = ["--json", "-e", regex, "--glob", filePattern || "*", "--context", cappedContextLines.toString()]
	if (excludeFilePatterns) {
		for (const pattern of excludeFilePatterns) {
			args.push("--glob", pattern)
		}
	}
	args.push(directoryPath)
	const argsDetails = {
		info: "regexSearchFiles args",
		args,
		cwd,
		directoryPath,
		filePattern,
		contextLines: cappedContextLines,
		hasDiracIgnore: !!diracIgnoreController,
	}
	await debugLog?.(argsDetails)

	let output: string
	try {
		output = await execRipgrep(args, debugLog)
	} catch (error) {
		await debugLog?.({
			info: "regexSearchFiles execRipgrep error",
			errorMessage: error instanceof Error ? error.message : String(error),
			stack: error instanceof Error ? error.stack : undefined,
		})
		throw Error("Error calling ripgrep", { cause: error })
	}
	const outputDetails = {
		info: "regexSearchFiles ripgrep output",
		outputLength: output.length,
		outputPreview: output.substring(0, 500),
		totalLines: output.split("\n").length,
	}
	await debugLog?.(outputDetails)

	const resultsByFile: Map<string, Map<number, SearchResultLine>> = new Map()

	output.split("\n").forEach((line) => {
		if (line) {
			try {
				const parsed = JSON.parse(line)
				if (parsed.type === "match" || parsed.type === "context") {
					const filePath = parsed.data.path.text
					const lineNum = parsed.data.line_number
					const isMatch = parsed.type === "match"
					const content = parsed.data.lines.text
					const column = isMatch ? parsed.data.submatches[0].start : undefined

					if (!resultsByFile.has(filePath)) {
						resultsByFile.set(filePath, new Map())
					}
					const fileLines = resultsByFile.get(filePath)!

					// Don't overwrite match with context if they somehow overlap
					if (isMatch || !fileLines.has(lineNum)) {
						fileLines.set(lineNum, { lineNum, content, isMatch, column })
					}
				}
			} catch (error) {
				Logger.error("Error parsing ripgrep output:", error)
				void debugLog?.({
					info: "regexSearchFiles parse line error",
					linePreview: line.substring(0, 300),
					errorMessage: error instanceof Error ? error.message : String(error),
				})
			}
		}
	})
	const parsedDetails = {
		info: "regexSearchFiles parsed",
		totalFilesParsed: resultsByFile.size,
		files: Array.from(resultsByFile.entries()).map(([file, lines]) => ({
			file,
			lineCount: lines.size,
			matchCount: Array.from(lines.values()).filter((line) => line.isMatch).length,
		})),
	}
	await debugLog?.(parsedDetails)

	const fileResults: FileSearchResult[] = []
	let finalMatchCount = 0
	for (const [filePath, lineMap] of resultsByFile.entries()) {
		// Filter by diracIgnoreController if provided
		if (diracIgnoreController && !diracIgnoreController.validateAccess(filePath)) {
			await debugLog?.({
				info: "regexSearchFiles diracIgnore filtered file",
				filePath,
			})
			continue
		}

		const sortedLines = Array.from(lineMap.values()).sort((a, b) => a.lineNum - b.lineNum)
		fileResults.push({ filePath, lines: sortedLines })
		finalMatchCount += sortedLines.filter((line) => line.isMatch).length
	}
	const finalDetails = {
		info: "regexSearchFiles final",
		filesBeforeIgnoreFilter: resultsByFile.size,
		filesAfterIgnoreFilter: fileResults.length,
		finalMatchCount,
	}
	await debugLog?.(finalDetails)

	return await formatResults(fileResults, finalMatchCount, cwd, taskId)
}

const MAX_RIPGREP_MB = 0.1
const MAX_BYTE_SIZE = MAX_RIPGREP_MB * 1024 * 1024 // 0.25MB in bytes
const MAX_LINE_LENGTH = 300

async function formatResults(results: FileSearchResult[], matchCount: number, cwd: string, taskId?: string): Promise<string> {
	let output = ""
	if (matchCount >= MAX_RESULTS) {
		output += `Showing first ${MAX_RESULTS} of ${matchCount.toLocaleString()}+ results. Use a more specific search if necessary.\n\n`
	} else {
		output += `Found ${matchCount === 1 ? "1 result" : `${matchCount.toLocaleString()} results`}.\n\n`
	}

	let byteSize = Buffer.byteLength(output, "utf8")
	let wasLimitReached = false

	// results are already sorted by file and then lineNum
	for (const fileResult of results) {
		const absoluteFilePath = fileResult.filePath
		const relPath = path.relative(cwd, absoluteFilePath)
		let anchors: string[] = []

		try {
			if (AnchorStateManager.isTracking(absoluteFilePath, taskId)) {
				anchors = AnchorStateManager.getAnchors(absoluteFilePath, taskId)!
			} else {
				const content = await fs.readFile(absoluteFilePath, "utf8")
				const lines = content.split(/\r?\n/)
				anchors = AnchorStateManager.reconcile(absoluteFilePath, lines, taskId)
			}
		} catch (error) {
			Logger.error(`Error reading file for search anchors: ${absoluteFilePath}`, error)
		}

		const filePathHeader = `${relPath.toPosix()}\n│----\n`
		const headerBytes = Buffer.byteLength(filePathHeader, "utf8")

		if (byteSize + headerBytes >= MAX_BYTE_SIZE) {
			wasLimitReached = true
			break
		}

		output += filePathHeader
		byteSize += headerBytes

		let fileSkippedResults = 0
		let lastLineNum = -1

		for (let i = 0; i < fileResult.lines.length; i++) {
			const line = fileResult.lines[i]

			if (line.content.length > MAX_LINE_LENGTH) {
				if (line.isMatch) fileSkippedResults++
				continue
			}

			// Add separator if there's a gap in line numbers
			if (lastLineNum !== -1 && line.lineNum !== lastLineNum + 1) {
				const separator = "│----\n"
				const separatorBytes = Buffer.byteLength(separator, "utf8")
				if (byteSize + separatorBytes >= MAX_BYTE_SIZE) {
					wasLimitReached = true
					break
				}
				output += separator
				byteSize += separatorBytes
			}

			const anchor = anchors[line.lineNum - 1] || `L${line.lineNum}`
			const trimmedLine = line.content.trimEnd()
			const hashedLine = formatLineWithHash(trimmedLine, anchor)
			const lineString = `│${hashedLine}\n`
			const lineBytes = Buffer.byteLength(lineString, "utf8")

			if (byteSize + lineBytes >= MAX_BYTE_SIZE) {
				wasLimitReached = true
				break
			}

			output += lineString
			byteSize += lineBytes
			lastLineNum = line.lineNum
		}

		if (wasLimitReached) break

		if (fileSkippedResults > 0) {
			const note = `│ (${fileSkippedResults} result${fileSkippedResults > 1 ? "s" : ""} skipped due to line length limits)\n`
			const noteBytes = Buffer.byteLength(note, "utf8")
			if (byteSize + noteBytes < MAX_BYTE_SIZE) {
				output += note
				byteSize += noteBytes
			}
		}

		const closing = "│----\n\n"
		const closingBytes = Buffer.byteLength(closing, "utf8")
		if (byteSize + closingBytes < MAX_BYTE_SIZE) {
			output += closing
			byteSize += closingBytes
		} else {
			wasLimitReached = true
			break
		}
	}

	if (wasLimitReached) {
		const truncationMessage = `\n[Results truncated due to exceeding the ${MAX_RIPGREP_MB}MB size limit. Please use a more specific search pattern.]`
		if (byteSize + Buffer.byteLength(truncationMessage, "utf8") < MAX_BYTE_SIZE) {
			output += truncationMessage
		}
	}

	return output.trim()
}
