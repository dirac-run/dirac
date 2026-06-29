import { extractSymbolLikeStrings } from "@core/context/instructions/user-instructions/rule-conditionals"
import { formatResponse } from "@core/formatResponse"
import { resolveWorkspacePath } from "@core/workspace"
import { isMultiRootEnabled } from "@core/workspace/multi-root-utils"
import { listFiles } from "@services/glob/list-files"
import { mentionRegexGlobal } from "@shared/context-mentions"
import { ASTAnchorBridge } from "@utils/ASTAnchorBridge"
import * as fs from "fs/promises"
import * as fsSync from "fs"
import * as readline from "readline"
import * as path from "path"
import { SymbolIndexService, SymbolLocation } from "../../../services/symbol-index/SymbolIndexService"
import { ContextLoaderDependencies } from "../types/context-loader"

// Thresholds for automatic symbol enrichment
const MAX_AUTO_SYMBOL_MATCHES = 3
const MAX_AUTO_SYMBOL_TOTAL_LINES = 20
const MAX_AUTO_SYMBOL_LINE_LENGTH_BYTES = 200
const MAX_AUTO_FILE_MATCHES = 3

// Regex matching path-like strings in text, preceded by whitespace/punctuation and followed by whitespace/punctuation
const pathRegex =
	/(?:^|[\s([{"'`])((?:\/?[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]*)+\/?|[A-Za-z0-9_.-]*\.[A-Za-z0-9_-]+|\.\.\/?|\.\/|\.\.))(?=$|[\s)\]}"'`,.;:!?])/g
const slashCommandInTextRegex = /(^|\s)\/([a-zA-Z0-9_.:@-]+)(?=\s|$)/g

interface PathMatch {
	relPath: string
	start: number
	end: number
}

export class FileContextLoader {
	constructor(private dependencies: ContextLoaderDependencies) {}

	// Extract file paths, directory paths, and symbols from text by scrubbing code fences, URLs, mentions, and slash commands
	async extractContext(
		text: string,
		cwd: string,
	): Promise<{ filePaths: string[]; directoryPaths: string[]; symbols: string[] }> {
		let scrubbedText = this.scrubNoise(text)
		// Collect files and consume their matches from text before scanning for directories
		const { paths: filePaths, text: afterFiles } = await this.collectPaths(scrubbedText, cwd, "file")
		scrubbedText = afterFiles
		const { paths: directoryPaths } = await this.collectPaths(scrubbedText, cwd, "directory")
		const symbols = extractSymbolLikeStrings(scrubbedText)
		return { filePaths, directoryPaths, symbols }
	}

	// Build file skeletons and directory listings for the given paths
	async getPathContext(
		filePaths: string[],
		directoryPaths: string[],
		cwd: string,
	): Promise<{ skeletons: string[]; directoryLists: string[] }> {
		if (filePaths.length === 0 && directoryPaths.length === 0) return { skeletons: [], directoryLists: [] }
		const skeletons = filePaths.length <= MAX_AUTO_FILE_MATCHES
			? await this.collectSkeletons(filePaths, cwd)
			: []
		const directoryLists = await this.collectDirectoryLists(directoryPaths, cwd)
		return { skeletons, directoryLists }
	}

	// Enrich context with symbol definitions and references from the symbol index
	async getSymbolContext(symbols: string[], cwd: string): Promise<string[]> {
		if (symbols.length === 0 || symbols.length > MAX_AUTO_SYMBOL_MATCHES) return []
		const indexService = SymbolIndexService.getInstance()
		const projectRoot = indexService.getProjectRoot() || cwd
		const results = this.initSymbolResults(symbols)
		let totalLinesAdded = 0

		// Pass 1: definitions first
		totalLinesAdded = await this.processSymbolPass(
			symbols,
			"definitions",
			indexService,
			projectRoot,
			cwd,
			results,
			totalLinesAdded,
		)
		// Pass 2: references
		totalLinesAdded = await this.processSymbolPass(
			symbols,
			"references",
			indexService,
			projectRoot,
			cwd,
			results,
			totalLinesAdded,
		)

		return this.assembleSymbolDefinitions(symbols, results)
	}

	// Scrub code fences, URLs, mentions, and slash commands to avoid false-positive path/symbol detection
	private scrubNoise(text: string): string {
		let scrubbed = text.replace(/```[\s\S]*?```/g, (m) => " ".repeat(m.length))
		scrubbed = scrubbed.replace(/\b\w+:\/\/[^\s]+/g, (m) => " ".repeat(m.length))
		scrubbed = scrubbed.replace(mentionRegexGlobal, (m) => " ".repeat(m.length))
		scrubbed = scrubbed.replace(slashCommandInTextRegex, (match, prefix) => prefix + " ".repeat(match.length - prefix.length))
		return scrubbed
	}

	// Find all path-like matches in text, filter by type via fs.stat, and consume matched paths from text
	private async collectPaths(
		text: string,
		cwd: string,
		type: "file" | "directory",
	): Promise<{ paths: string[]; text: string }> {
		const candidates = this.getPathMatches(text)
		const paths: string[] = []
		const seen = new Set<string>()
		let consumedText = text
		for (const pc of candidates) {
			if (seen.has(pc.relPath)) continue
			seen.add(pc.relPath)
			if (type === "file" && paths.length >= MAX_AUTO_FILE_MATCHES) break
			try {
				const absolutePath = this.resolveAbsolute(pc.relPath, cwd)
				const stats = await fs.stat(absolutePath)
				if (type === "file" ? stats.isFile() : stats.isDirectory()) {
					paths.push(pc.relPath)
					consumedText = this.consumePath(consumedText, pc)
				}
			} catch {
				/* Ignore errors for individual paths */
			}
		}
		return { paths, text: consumedText }
	}

	// Replace a consumed path match with spaces of equal length to preserve text positions
	private consumePath(text: string, match: PathMatch): string {
		const before = text.substring(0, match.start)
		const after = text.substring(match.end)
		return before + " ".repeat(match.relPath.length) + after
	}

	// Resolve a relative path to absolute using workspace context
	private resolveAbsolute(relPath: string, cwd: string): string {
		const pathResult = resolveWorkspacePath(
			{
				cwd,
				workspaceManager: this.dependencies.workspaceManager,
				isMultiRootEnabled: isMultiRootEnabled(this.dependencies.stateManager),
			},
			relPath,
			"Task.loadContext.context",
		)
		return typeof pathResult === "string" ? pathResult : pathResult.absolutePath
	}

	// Execute regex against text and collect path matches with positions, trimming trailing punctuation
	private getPathMatches(currentText: string): PathMatch[] {
		const matches: PathMatch[] = []
		let match: RegExpExecArray | null
		pathRegex.lastIndex = 0
		while ((match = pathRegex.exec(currentText)) !== null) {
			let relPath = match[1]
			const start = match.index + match[0].indexOf(relPath)
			// Trim trailing punctuation/dashes unless it's "." or ".."
			while (relPath.length > 0 && /[,.;:!?-]$/.test(relPath)) {
				if (relPath === "." || relPath === "..") break
				relPath = relPath.slice(0, -1)
			}
			if (relPath) matches.push({ relPath, start, end: start + relPath.length })
		}
		return matches
	}

	// Collect AST skeletons for file paths
	private async collectSkeletons(filePaths: string[], cwd: string): Promise<string[]> {
		const skeletons: string[] = []
		for (const relPath of filePaths) {
			try {
				const absolutePath = this.resolveAbsolute(relPath, cwd)
				const skeleton = await ASTAnchorBridge.getFileSkeleton(
					absolutePath,
					this.dependencies.diracIgnoreController,
					this.dependencies.ulid,
					{ showCallGraph: true },
				)
				if (skeleton && !skeleton.includes("Unsupported file type")) {
					skeletons.push(`<file_skeleton path="${relPath}">\n${skeleton}\n</file_skeleton>`)
				}
			} catch {
				/* Ignore errors for individual files */
			}
		}
		return skeletons
	}

	// Collect directory listings, capped at 3 directories
	private async collectDirectoryLists(directoryPaths: string[], cwd: string): Promise<string[]> {
		const directoryLists: string[] = []
		let count = 0
		for (const relPath of directoryPaths) {
			if (count >= 3) break
			try {
				const absolutePath = this.resolveAbsolute(relPath, cwd)
				const [fileInfos, didHitLimit] = await listFiles(absolutePath, false, 30)
				const result = formatResponse.formatFilesList(
					absolutePath,
					fileInfos,
					didHitLimit,
					this.dependencies.diracIgnoreController,
				)
				const note = `Note: The following context was automatically included because the directory "${relPath}" was mentioned in user's message.`
				directoryLists.push(`<directory_list path="${relPath}">\n${note}\n\n${result}\n</directory_list>`)
				count++
			} catch {
				/* Ignore errors */
			}
		}
		return directoryLists
	}

	// Initialize per-symbol result tracking structures
	private initSymbolResults(
		symbols: string[],
	): Map<string, { allLocations: SymbolLocation[]; addedLines: string[]; seenLocations: Set<string> }> {
		const results = new Map<string, { allLocations: SymbolLocation[]; addedLines: string[]; seenLocations: Set<string> }>()
		for (const symbol of symbols) results.set(symbol, { allLocations: [], addedLines: [], seenLocations: new Set<string>() })
		return results
	}

	// Process one pass (definitions or references) for all symbols, respecting line limits
	private async processSymbolPass(
		symbols: string[],
		passType: "definitions" | "references",
		indexService: SymbolIndexService,
		projectRoot: string,
		cwd: string,
		results: Map<string, { allLocations: SymbolLocation[]; addedLines: string[]; seenLocations: Set<string> }>,
		totalLinesAdded: number,
	): Promise<number> {
		for (const symbol of symbols) {
			if (totalLinesAdded >= MAX_AUTO_SYMBOL_TOTAL_LINES) break
			const remainingLimit = MAX_AUTO_SYMBOL_TOTAL_LINES - totalLinesAdded
			const locations =
				passType === "definitions"
					? indexService.getDefinitions(symbol, MAX_AUTO_SYMBOL_TOTAL_LINES)
					: indexService.getReferences(symbol, remainingLimit)
			results.get(symbol)!.allLocations.push(...locations)
			for (const loc of locations) {
				if (totalLinesAdded >= MAX_AUTO_SYMBOL_TOTAL_LINES) break
				if (await this.processLocation(symbol, loc, projectRoot, cwd, results)) totalLinesAdded++
			}
		}
		return totalLinesAdded
	}

	// Read and format a single symbol location, skipping duplicates and overly long lines
	private async processLocation(
		symbol: string,
		loc: SymbolLocation,
		projectRoot: string,
		cwd: string,
		results: Map<string, { allLocations: SymbolLocation[]; addedLines: string[]; seenLocations: Set<string> }>,
	): Promise<boolean> {
		const data = results.get(symbol)!
		const locKey = `${loc.path}:${loc.startLine}`
		if (data.seenLocations.has(locKey)) return false
		try {
			const absLocPath = path.isAbsolute(loc.path) ? loc.path : path.join(projectRoot, loc.path)
			let lineContent = await this.readLineAt(absLocPath, loc.startLine)
			if (lineContent === "") return false
			if (Buffer.byteLength(lineContent, "utf8") > MAX_AUTO_SYMBOL_LINE_LENGTH_BYTES)
				lineContent = "(line too long, skipped)"
			const relLocPath = path.relative(cwd, absLocPath)
			data.addedLines.push(`    - ${relLocPath}:${loc.startLine + 1} [${loc.type}] \`${lineContent}\``)
			data.seenLocations.add(locKey)
			return true
		} catch {
			return false
		}
	}

	// Read a single line from a file at the given line number without loading the entire file
	private async readLineAt(filePath: string, targetLine: number): Promise<string> {
		const stream = fsSync.createReadStream(filePath, { encoding: "utf8" })
		const rl = readline.createInterface({ input: stream, crlfDelay: Infinity })
		let lineNum = 0
		for await (const line of rl) {
			if (lineNum === targetLine) {
				rl.close()
				stream.destroy()
				return line.trim()
			}
			lineNum++
		}
		stream.destroy()
		return ""
	}

	// Assemble final symbol context strings from collected results
	private assembleSymbolDefinitions(
		symbols: string[],
		results: Map<string, { allLocations: SymbolLocation[]; addedLines: string[]; seenLocations: Set<string> }>,
	): string[] {
		const definitions: string[] = []
		for (const symbol of symbols) {
			const data = results.get(symbol)!
			if (data.addedLines.length === 0) continue
			const numLocations = data.allLocations.length
			const lines: string[] = [
				`Note: The following context was automatically included because the symbol "${symbol}" was mentioned in user's message.`,
				numLocations <= MAX_AUTO_SYMBOL_TOTAL_LINES
					? `All ${numLocations} symbols found in the codebase are listed below.`
					: `${MAX_AUTO_SYMBOL_TOTAL_LINES} out of ${numLocations} symbol listed below (definitions first).`,
				`symbol_context:`,
				`  ${symbol}:`,
				...data.addedLines,
			]
			definitions.push(lines.join("\n"))
		}
		return definitions
	}
}
