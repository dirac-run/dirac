import type { PathAccessValidator } from "@shared/path-access"
import { AnchorStateManager } from "@utils/AnchorStateManager"
import { formatLineWithHash } from "@utils/line-hashing"
import * as childProcess from "child_process"
import * as fs from "fs/promises"
import * as path from "path"
import * as readline from "readline"
import { getErrorMessage } from "@/shared/errors"
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

function spawnRipgrepProcess(binPath: string, args: string[]) {
	return childProcess.spawn(binPath, args, { stdio: ["ignore", "pipe", "pipe"] })
}
export type RipgrepProcessSpawner = typeof spawnRipgrepProcess

export async function execRipgrep(
	args: string[],
	signal?: AbortSignal,
	spawnProcess: RipgrepProcessSpawner = spawnRipgrepProcess,
): Promise<string> {
	const binPath: string = await getBinaryLocation("rg")
	if (signal?.aborted) {
		throw signal.reason instanceof Error ? signal.reason : new Error("Ripgrep search aborted")
	}

	return new Promise((resolve, reject) => {
		const rgProcess = spawnProcess(binPath, args)
		// cross-platform alternative to head, which is ripgrep author's recommendation for limiting output.
		const rl = readline.createInterface({
			input: rgProcess.stdout,
			crlfDelay: Number.POSITIVE_INFINITY, // treat \r\n as a single line break even if it's split across chunks. This ensures consistent behavior across different operating systems.
		})

		let output = ""
		let lineCount = 0
		let errorOutput = ""
		let settled = false
		let killedAfterOutputLimit = false
		let killedAfterAbort = false
		const maxLines = MAX_RESULTS * 5 // limiting ripgrep output with max lines since there's no other way to limit results. it's okay that we're outputting as json, since we're parsing it line by line and ignore anything that's not part of a match. This assumes each result is at most 5 lines.

		const finish = (error: Error | undefined, value?: string) => {
			if (settled) return
			settled = true
			signal?.removeEventListener("abort", abortSearch)
			if (error) {
				reject(error)
				return
			}
			resolve(value || "")
		}

		const buildFailureMessage = (reason: string) => {
			const stderr = errorOutput.trim()
			return [reason, `binary: ${binPath}`, `args: ${args.join(" ")}`, stderr ? `stderr: ${stderr}` : undefined]
				.filter(Boolean)
				.join("\n")
		}

		rl.on("line", (line) => {
			if (killedAfterOutputLimit || killedAfterAbort) return
			if (lineCount < maxLines) {
				output += line + "\n"
				lineCount++
				return
			}

			killedAfterOutputLimit = true
			rgProcess.kill()
			finish(undefined, output)
		})

		const abortSearch = () => {
			killedAfterAbort = true
			rgProcess.kill()
			const reason = signal?.reason instanceof Error ? signal.reason : new Error("Ripgrep search aborted")
			finish(reason)
		}
		signal?.addEventListener("abort", abortSearch, { once: true })
		if (signal?.aborted) abortSearch()

		rgProcess.stderr.on("data", (data) => {
			errorOutput += data.toString()
		})

		rgProcess.on("error", (error) => {
			finish(new Error(buildFailureMessage(`ripgrep spawn failed: ${error.message}`)))
		})

		rgProcess.on("close", (code, signal) => {
			if (killedAfterOutputLimit) {
				finish(undefined, output)
				return
			}
			if (killedAfterAbort) return

			if (code !== 0 && code !== 1) {
				finish(new Error(buildFailureMessage(`ripgrep exited with code ${code}${signal ? ` and signal ${signal}` : ""}`)))
				return
			}

			finish(undefined, output)
		})
	})
}

export async function regexSearchFiles(
	cwd: string,
	directoryPath: string,
	regex: string,
	filePattern?: string,
	diracIgnoreController?: PathAccessValidator,
	anchorTaskId?: string,
	contextLines?: number,
	excludeFilePatterns?: string[],
	includeAnchors?: boolean,
	onAnchorStateChanged?: (absolutePath: string) => void,
	signal?: AbortSignal,
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

	let output: string
	try {
		output = await execRipgrep(args, signal)
	} catch (error) {
		const causeMessage = getErrorMessage(error)
		throw new Error(`Error calling ripgrep: ${causeMessage}`, { cause: error })
	}

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
			}
		}
	})

	const fileResults: FileSearchResult[] = []
	let finalMatchCount = 0
	for (const [filePath, lineMap] of resultsByFile.entries()) {
		// Filter by diracIgnoreController if provided
		if (diracIgnoreController && !diracIgnoreController.validateAccess(filePath)) {
			continue
		}

		const sortedLines = Array.from(lineMap.values()).sort((a, b) => a.lineNum - b.lineNum)
		fileResults.push({ filePath, lines: sortedLines })
		finalMatchCount += sortedLines.filter((line) => line.isMatch).length
	}

	return await formatResults(fileResults, finalMatchCount, cwd, anchorTaskId, includeAnchors, onAnchorStateChanged)
}

const MAX_RIPGREP_MB = 0.1
const MAX_BYTE_SIZE = MAX_RIPGREP_MB * 1024 * 1024 // 0.25MB in bytes
const MAX_LINE_LENGTH = 300

export async function formatResults(
	results: FileSearchResult[],
	matchCount: number,
	cwd: string,
	anchorTaskId?: string,
	includeAnchors?: boolean,
	onAnchorStateChanged?: (absolutePath: string) => void,
): Promise<string> {
	let output = matchCount >= MAX_RESULTS
		? `Showing first ${MAX_RESULTS} of ${matchCount.toLocaleString()}+ results. Use a more specific search if necessary.\n\n`
		: `Found ${matchCount === 1 ? "1 result" : `${matchCount.toLocaleString()} results`}.\n\n`
	let byteSize = Buffer.byteLength(output, "utf8")
	let wasLimitReached = false

	for (const fileResult of results) {
		const absoluteFilePath = fileResult.filePath
		const relPath = path.relative(cwd, absoluteFilePath)
		let currentLines: string[] | undefined
		let anchors: string[] | undefined

		if (includeAnchors) {
			try {
				currentLines = (await fs.readFile(absoluteFilePath, "utf8")).split(/\r?\n/)
				const result = AnchorStateManager.reconcileWithChanges(absoluteFilePath, currentLines, anchorTaskId)
				anchors = result.anchors
				if (result.changed) onAnchorStateChanged?.(absoluteFilePath)
			} catch (error) {
				Logger.error(`Error reading file for search anchors: ${absoluteFilePath}`, error)
				const message = `${relPath}\n[Anchored results unavailable because the file could not be reread. Rerun search_files.]\n\n`
				if (byteSize + Buffer.byteLength(message, "utf8") >= MAX_BYTE_SIZE) {
					wasLimitReached = true
					break
				}
				output += message
				byteSize += Buffer.byteLength(message, "utf8")
				continue
			}

			const changedDuringSearch = fileResult.lines.some((line) => {
				const searchedContent = line.content.replace(/\r?\n$/, "")
				return currentLines?.[line.lineNum - 1] !== searchedContent
			})
			if (changedDuringSearch) {
				const message = `${relPath}\n[Anchored results omitted because the file changed during search. Rerun search_files for current coordinates.]\n\n`
				if (byteSize + Buffer.byteLength(message, "utf8") >= MAX_BYTE_SIZE) {
					wasLimitReached = true
					break
				}
				output += message
				byteSize += Buffer.byteLength(message, "utf8")
				continue
			}
		}

		const filePathHeader = `${relPath.toPosix()}\n│----\n`
		if (byteSize + Buffer.byteLength(filePathHeader, "utf8") >= MAX_BYTE_SIZE) {
			wasLimitReached = true
			break
		}
		output += filePathHeader
		byteSize += Buffer.byteLength(filePathHeader, "utf8")

		if (includeAnchors && matchCount <= 5) {
			const matches = fileResult.lines.filter((line) => line.isMatch)
			const matchLines = matches.map((line) => currentLines![line.lineNum - 1])
			if (matches.length > 0 && matchLines.every((line) => line.length <= MAX_LINE_LENGTH)) {
				const summary = `Matches: ${matches.map((line, index) => `${line.lineNum} ${JSON.stringify(matchLines[index])}`).join(", ")}\n`
				if (byteSize + Buffer.byteLength(summary, "utf8") < MAX_BYTE_SIZE) {
					output += summary
					byteSize += Buffer.byteLength(summary, "utf8")
				}
			}
		}


		let fileSkippedResults = 0
		let lastLineNum = -1
		for (const line of fileResult.lines) {
			const sourceLine = includeAnchors ? currentLines![line.lineNum - 1] : line.content.replace(/\r?\n$/, "")
			if (!includeAnchors && sourceLine.length > MAX_LINE_LENGTH) {
				if (line.isMatch) fileSkippedResults++
				continue
			}

			if (lastLineNum !== -1 && line.lineNum !== lastLineNum + 1) {
				const separator = `--- ${line.lineNum - lastLineNum - 1} lines skipped ---\n`
				if (byteSize + Buffer.byteLength(separator, "utf8") >= MAX_BYTE_SIZE) {
					wasLimitReached = true
					break
				}
				output += separator
				byteSize += Buffer.byteLength(separator, "utf8")
			}

			const displayLine = includeAnchors
				? formatLineWithHash(sourceLine, anchors![line.lineNum - 1])
				: sourceLine
			const matchMarker = includeAnchors && line.isMatch ? `--- match at line ${line.lineNum} ---\n` : ""
			const lineString = `${matchMarker}${includeAnchors ? displayLine : `│${displayLine}`}\n`
			if (byteSize + Buffer.byteLength(lineString, "utf8") >= MAX_BYTE_SIZE) {
				wasLimitReached = true
				break
			}
			output += lineString
			byteSize += Buffer.byteLength(lineString, "utf8")
			lastLineNum = line.lineNum
		}
		if (wasLimitReached) break

		if (fileSkippedResults > 0) {
			const note = `│ (${fileSkippedResults} result${fileSkippedResults > 1 ? "s" : ""} skipped due to line length limits)\n`
			if (byteSize + Buffer.byteLength(note, "utf8") < MAX_BYTE_SIZE) {
				output += note
				byteSize += Buffer.byteLength(note, "utf8")
			}
		}

		const closing = "│----\n\n"
		if (byteSize + Buffer.byteLength(closing, "utf8") < MAX_BYTE_SIZE) {
			output += closing
			byteSize += Buffer.byteLength(closing, "utf8")
		} else {
			wasLimitReached = true
			break
		}
	}

	if (wasLimitReached) {
		const truncationMessage = `\n[Results truncated due to exceeding the ${MAX_RIPGREP_MB}MB size limit. Please use a more specific search pattern.]`
		if (byteSize + Buffer.byteLength(truncationMessage, "utf8") < MAX_BYTE_SIZE) output += truncationMessage
	}
	return output.replace(/\n+$/, "")
}
