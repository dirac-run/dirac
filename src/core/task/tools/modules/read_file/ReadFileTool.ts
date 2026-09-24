import * as path from "node:path"
import { formatResponse } from "@core/formatResponse"
import {
	anchorByteLimitMessage,
	anchorLimitMessage,
	MAX_ANCHORED_FILE_BYTES,
	MAX_ANCHORED_FILE_LINES,
} from "@shared/anchor-limits"
import { contentHash, formatLinesForModel, getDelimiter } from "@utils/line-hashing"
import { CardStatus } from "@/shared/ExtensionMessage"
import { getErrorMessage } from "@/shared/errors"
import { DiracIcon } from "@/shared/icons"
import { DiracDefaultTool, DiracToolSpec } from "@/shared/tools"
import { IDiracTool } from "../../interfaces/IDiracTool"
import { IToolEnvironment } from "../../interfaces/IToolEnvironment"
import { SurfaceType } from "../../interfaces/SurfaceType"
import { ToolExecutionDeadline, ToolTimeoutError } from "../../runtime/ToolExecutionDeadline"
import { presentToolTimeout } from "../../runtime/ToolTimeoutPresentation"

export interface ReadFileArgs {
	paths: string[]
	start_line?: number
	end_line?: number
	include_anchors?: boolean
}

interface LineRange {
	start: number
	end?: number
}

interface TextSelection {
	text: string
	lines: string[]
	totalLineCount: number
	startIndex: number
	endIndex: number
	coversWholeFile: boolean
}

interface FullReadCacheRecord {
	contentHash: string
	anchorFingerprint?: string
}

type FileReadCache = Record<string, string | FullReadCacheRecord>

const MAX_TEXT_READ_SIZE = 50 * 1024
const NON_EDITABLE_RICH_EXTENSIONS = new Set([".pdf", ".docx", ".xlsx", ".png", ".jpg", ".jpeg", ".webp"])
const EXTRACTED_CONTENT_EXTENSIONS = new Set([...NON_EDITABLE_RICH_EXTENSIONS, ".ipynb"])

export const read_file_spec: DiracToolSpec = {
	id: DiracDefaultTool.FILE_READ,
	name: "read_file",
	description:
		"Reads complete files or selected line ranges, including extracted text from rich files such as PDF, DOCX, notebooks, and spreadsheets. Text ranges are streamed so late ranges do not require loading an oversized file into memory. Prefer inspect_ast when source structure or symbol identity matters. For editable text/source files, set include_anchors: true to read exact raw source lines as standalone coordinates required by edit_file. Files over 50,000 lines or 20 MiB remain readable by range but do not support anchors, edit_file, or duplicate-read caching. Extracted rich-file and image content is read-only and cannot provide edit_file coordinates.",
	parameters: [
		{
			name: "paths",
			required: true,
			type: "array",
			items: { type: "string" },
			instruction: "An array of relative paths to the source files.",
		},
		{
			name: "start_line",
			required: false,
			type: "integer",
			instruction: "Optional. If not supplied, output will start from line 1.",
		},
		{
			name: "end_line",
			required: false,
			type: "integer",
			instruction: "Optional. If not supplied, the output will go until the last line",
		},
		{
			name: "include_anchors",
			required: false,
			type: "boolean",
			instruction:
				`Optional. For editable text/source files of at most ${MAX_ANCHORED_FILE_LINES.toLocaleString()} lines and ${MAX_ANCHORED_FILE_BYTES / 1024 / 1024} MiB, true reads raw source and returns each selected line as a complete ANCHOR${getDelimiter()}CONTENT coordinate required by edit_file. Larger files return plain text and cannot be edited with edit_file. Default false.`,
		},
	],
}

export class ReadFileTool implements IDiracTool<ReadFileArgs> {
	spec(): DiracToolSpec {
		return read_file_spec
	}

	supportedSurfaces(): SurfaceType[] {
		return ["all"]
	}

	async processCall(args: ReadFileArgs, env: IToolEnvironment): Promise<any> {
		const paths = Array.isArray(args.paths) ? args.paths : args.paths ? [args.paths] : []
		if (paths.length === 0) {
			this.incrementMistakeCount(env)
			return formatResponse.toolError("Missing required parameter: paths")
		}

		const lineRange = this.parseLineRange(args.start_line, args.end_line)
		const includeAnchors = args.include_anchors === true
		const deadline = new ToolExecutionDeadline(this.spec().name)
		const results: string[] = []
		const contentBlocks: any[] = []
		const cacheUpdates: FileReadCache = {}
		const cacheDeletions = new Set<string>()
		const loadedCache = new Map<string, FileReadCache[string] | undefined>()
		let anySucceeded = false

		const getFileHash = async (cacheKey: string): Promise<FileReadCache[string] | undefined> => {
			if (loadedCache.has(cacheKey)) return loadedCache.get(cacheKey)
			const value = await deadline.run("loading the file-read cache entry", async () =>
				await env.context.task.getEntry<FileReadCache[string]>("fileHashes", cacheKey))
			loadedCache.set(cacheKey, value)
			return value
		}

		for (const relPath of paths) {
			const { success, result, contentBlock } = await this.readFileContent(
				relPath,
				paths.length > 1,
				lineRange,
				getFileHash,
				cacheUpdates,
				cacheDeletions,
				env,
				includeAnchors,
				deadline,
			)
			anySucceeded ||= success
			results.push(result)
			if (contentBlock) contentBlocks.push(contentBlock)
		}

		this.updateTaskState(anySucceeded, env)
		if (Object.keys(cacheUpdates).length > 0 || cacheDeletions.size > 0) {
			try {
				await deadline.run("saving the file-read cache", async () =>
					await env.context.task.updateEntries("fileHashes", cacheUpdates, [...cacheDeletions]))
			} catch (error) {
				if (error instanceof ToolTimeoutError) return await presentToolTimeout(env, error)
				throw error
			}
		}

		const finalResultText = results.join("\n\n")
		return contentBlocks.length > 0
			? [{ type: "text", text: finalResultText }, ...contentBlocks]
			: finalResultText
	}

	private async readFileContent(
		relPath: string,
		isMultiFile: boolean,
		lineRange: LineRange | undefined,
		getFileHash: (cacheKey: string) => Promise<FileReadCache[string] | undefined>,
		cacheUpdates: FileReadCache,
		cacheDeletions: Set<string>,
		env: IToolEnvironment,
		includeAnchors: boolean,
		deadline: ToolExecutionDeadline,
	): Promise<{ success: boolean; result: string; contentBlock?: any }> {
		const header = isMultiFile ? `--- ${relPath} ---\n` : ""
		let absolutePath = ""
		let displayPath = relPath
		let usedWorkspaceHint = false
		let card: any | undefined

		try {
			const resolved = await deadline.run(`resolving ${relPath}`, async () => await env.workspace.resolvePath(relPath))
			absolutePath = resolved.absolutePath
			displayPath = resolved.displayPath
			usedWorkspaceHint = displayPath !== relPath

			const rangeLabel = lineRange ? `lines ${lineRange.start}-${lineRange.end ?? "end"}` : undefined
			card = !env.config.isSubagentExecution
				? await env.ui.createCard({
					header: rangeLabel ? `Reading ${rangeLabel} from ${displayPath}` : `Reading from ${displayPath}`,
					icon: DiracIcon.FILE_READ,
					collapsed: true,
					locations: [{ path: relPath, ...(lineRange ? { line: lineRange.start } : {}) }],
				})
				: undefined

			const extension = path.extname(absolutePath).toLowerCase()
			if (includeAnchors && NON_EDITABLE_RICH_EXTENSIONS.has(extension)) {
				throw new Error("Line anchors are unavailable for extracted rich-file or image content. Read the editable source file that will actually be changed.")
			}

			const useRawText = includeAnchors || !EXTRACTED_CONTENT_EXTENSIONS.has(extension)
			const readResult = useRawText
				? await this.readRawText(
					absolutePath,
					displayPath,
					header,
					lineRange,
					getFileHash,
					cacheUpdates,
					cacheDeletions,
					env,
					includeAnchors,
					deadline,
				)
				: await this.readExtractedContent(
					absolutePath,
					displayPath,
					header,
					lineRange,
					getFileHash,
					cacheUpdates,
					cacheDeletions,
					env,
					deadline,
				)

			if (card) {
				await card.update({
					header: rangeLabel ? `Read ${rangeLabel} from ${displayPath}` : `Read from ${displayPath}`,
					status: CardStatus.SUCCESS,
					body: `✓ Successfully read ${displayPath}${rangeLabel ? ` (${rangeLabel})` : ""}`,
				})
				await card.finalize(CardStatus.SUCCESS)
			}
			this.captureReadTelemetry(relPath, usedWorkspaceHint, env)
			return { success: true, ...readResult }
		} catch (error: any) {
			if (error instanceof ToolTimeoutError) return await presentToolTimeout(env, error, card ? [card] : [])
			const errorMessage = getErrorMessage(error)
			const normalizedMessage = errorMessage.startsWith("Error reading file:")
				? errorMessage
				: `Error reading file: ${errorMessage}`
			if (card) {
				await card.update({ status: CardStatus.ERROR, body: `✕ ${normalizedMessage}` })
				await card.finalize(CardStatus.ERROR)
			}
			env.telemetry.captureCustomMetadata({
				path: relPath,
				isMultiRootEnabled: env.config.isMultiRootEnabled || false,
				usedWorkspaceHint,
				resolutionMethod: "error",
			})
			return { success: false, result: `${header}${normalizedMessage}` }
		}
	}

	private async readRawText(
		absolutePath: string,
		displayPath: string,
		header: string,
		lineRange: LineRange | undefined,
		getFileHash: (cacheKey: string) => Promise<FileReadCache[string] | undefined>,
		cacheUpdates: FileReadCache,
		cacheDeletions: Set<string>,
		env: IToolEnvironment,
		includeAnchors: boolean,
		deadline: ToolExecutionDeadline,
	): Promise<{ result: string }> {
		const range = lineRange ?? { start: 1 }
		const retainCompleteText = includeAnchors || lineRange === undefined
		const window = await deadline.run(`streaming ${displayPath}`, async (signal) =>
			await env.workspace.readTextFileWindow(absolutePath, {
				startLine: range.start,
				endLine: range.end,
				maxSelectedBytes: MAX_TEXT_READ_SIZE,
				maxRetainedLines: retainCompleteText ? MAX_ANCHORED_FILE_LINES : 0,
				maxRetainedBytes: retainCompleteText ? MAX_ANCHORED_FILE_BYTES : 0,
				signal,
			}))

		if (range.start > window.totalLineCount) {
			throw new Error(
				`start_line ${range.start} exceeds file length (${window.totalLineCount} lines). No content in specified range.`,
			)
		}

		const clearUnsupportedState = async () => {
			cacheDeletions.add(`${absolutePath}#plain`)
			cacheDeletions.add(`${absolutePath}#anchored`)
			await deadline.run("clearing unsupported source anchors", async () => {
				await env.context.ensureAnchorState()
				env.anchors.clear(absolutePath)
			})
		}
		const selectWindow = () => {
			this.enforceSelectedByteCount(window.selectedByteCount)
			return this.selectionFromWindow(window.selectedLines!, window.totalLineCount, lineRange)
		}

		const lineLimitExceeded = window.totalLineCount > MAX_ANCHORED_FILE_LINES
		const byteLimitExceeded = window.totalByteCount > MAX_ANCHORED_FILE_BYTES
		if (lineLimitExceeded || byteLimitExceeded) {
			await clearUnsupportedState()
			const selection = selectWindow()
			const limitMessage = lineLimitExceeded
				? anchorLimitMessage(window.totalLineCount)
				: anchorByteLimitMessage()
			const notice = includeAnchors ? `\n[Hash anchoring unavailable: ${limitMessage}]` : ""
			return { result: `${header}${this.selectionHeader(selection, lineRange)}${notice}\n${selection.text}` }
		}

		if (retainCompleteText && window.completeText === undefined) {
			await clearUnsupportedState()
			const selection = selectWindow()
			const notice = includeAnchors
				? `\n[Hash anchoring unavailable: ${anchorByteLimitMessage()}]`
				: ""
			return { result: `${header}${this.selectionHeader(selection, lineRange)}${notice}\n${selection.text}` }
		}

		const selection = selectWindow()
		if (!includeAnchors && lineRange !== undefined) {
			return { result: `${header}${this.selectionHeader(selection, lineRange)}\n${selection.text}` }
		}

		const completeText = window.completeText!
		const currentHash = contentHash(completeText)
		let anchors: string[] | undefined
		let anchorFingerprint: string | undefined
		if (includeAnchors) {
			await deadline.run("preparing source anchors", async () => await env.context.ensureAnchorState())
			const allLines = completeText.split(/\r?\n/)
			anchors = env.anchors.reconcile(absolutePath, allLines)
			anchorFingerprint = env.anchors.getDocumentFingerprint(absolutePath) ?? undefined
		}

		const cacheKey = `${absolutePath}#${includeAnchors ? "anchored" : "plain"}`
		if (selection.coversWholeFile) {
			const cachedRead = await getFileHash(cacheKey)
			const contentMatches =
				typeof cachedRead === "string" ? cachedRead === currentHash : cachedRead?.contentHash === currentHash
			if (!includeAnchors && contentMatches) {
				return { result: `${header}no changes have been made to the file since your last read (Hash: ${currentHash})` }
			}
			cacheUpdates[cacheKey] = includeAnchors
				? { contentHash: currentHash, anchorFingerprint }
				: { contentHash: currentHash }
		}

		const formattedContent = anchors
			? formatLinesForModel(selection.lines, anchors.slice(selection.startIndex, selection.endIndex), true)
			: selection.text
		const rangeHeader = lineRange ? `\n${this.selectionHeader(selection, lineRange)}` : ""
		return { result: `${header}[File Hash: ${currentHash}]${rangeHeader}\n${formattedContent}` }
	}

	private async readExtractedContent(
		absolutePath: string,
		displayPath: string,
		header: string,
		lineRange: LineRange | undefined,
		getFileHash: (cacheKey: string) => Promise<FileReadCache[string] | undefined>,
		cacheUpdates: FileReadCache,
		cacheDeletions: Set<string>,
		env: IToolEnvironment,
		deadline: ToolExecutionDeadline,
	): Promise<{ result: string; contentBlock?: any }> {
		const fileContent = await deadline.run(`extracting ${displayPath}`, async () =>
			await env.workspace.readRichFile(absolutePath))
		if (fileContent.imageBlock) {
			return { result: `${header}${fileContent.text}`, contentBlock: fileContent.imageBlock }
		}

		const selection = this.selectText(fileContent.text, lineRange)
		this.enforceSelectedByteCount(Buffer.byteLength(selection.text, "utf8"))
		if (selection.totalLineCount > MAX_ANCHORED_FILE_LINES) {
			cacheDeletions.add(`${absolutePath}#plain`)
			return { result: `${header}${this.selectionHeader(selection, lineRange)}\n${selection.text}` }
		}

		const currentHash = contentHash(fileContent.text)
		const cacheKey = `${absolutePath}#plain`
		if (selection.coversWholeFile) {
			const cachedRead = await getFileHash(cacheKey)
			const contentMatches =
				typeof cachedRead === "string" ? cachedRead === currentHash : cachedRead?.contentHash === currentHash
			if (contentMatches) {
				return { result: `${header}no changes have been made to the file since your last read (Hash: ${currentHash})` }
			}
			cacheUpdates[cacheKey] = { contentHash: currentHash }
		}

		const rangeHeader = lineRange ? `\n${this.selectionHeader(selection, lineRange)}` : ""
		return { result: `${header}[File Hash: ${currentHash}]${rangeHeader}\n${selection.text}` }
	}

	private selectionHeader(selection: TextSelection, lineRange: LineRange | undefined): string {
		return lineRange
			? `[Lines: ${selection.startIndex + 1}-${selection.endIndex} of ${selection.totalLineCount}]`
			: `[Total lines: ${selection.totalLineCount}]`
	}

	private parseLineRange(startLine: number | undefined, endLine: number | undefined): LineRange | undefined {
		if (startLine === undefined && endLine === undefined) return undefined
		const parseLineNumber = (name: string, value: number | undefined): number | undefined => {
			if (value === undefined) return undefined
			const parsed = Number(value)
			if (!Number.isInteger(parsed) || parsed < 1) throw new Error(`Invalid ${name}: must be an integer >= 1.`)
			return parsed
		}
		const start = parseLineNumber("start_line", startLine) ?? 1
		const end = parseLineNumber("end_line", endLine)
		if (end !== undefined && start > end) {
			throw new Error(`Invalid line range: start_line ${start} cannot be greater than end_line ${end}.`)
		}
		return { start, end }
	}

	private selectionFromWindow(selectedLines: string[], totalLineCount: number, lineRange: LineRange | undefined): TextSelection {
		const startIndex = (lineRange?.start ?? 1) - 1
		const endIndex = Math.min(lineRange?.end ?? totalLineCount, totalLineCount)
		return {
			text: selectedLines.join("\n"),
			lines: selectedLines,
			totalLineCount,
			startIndex,
			endIndex,
			coversWholeFile: startIndex === 0 && endIndex === totalLineCount,
		}
	}

	private selectText(text: string, lineRange: LineRange | undefined): TextSelection {
		const lines = text.split(/\r?\n/)
		if (!lineRange) {
			return { text, lines, totalLineCount: lines.length, startIndex: 0, endIndex: lines.length, coversWholeFile: true }
		}
		if (lineRange.start > lines.length) {
			throw new Error(
				`start_line ${lineRange.start} exceeds file length (${lines.length} lines). No content in specified range.`,
			)
		}
		const startIndex = lineRange.start - 1
		const endIndex = Math.min(lineRange.end ?? lines.length, lines.length)
		const selectedLines = lines.slice(startIndex, endIndex)
		return {
			text: selectedLines.join("\n"),
			lines: selectedLines,
			totalLineCount: lines.length,
			startIndex,
			endIndex,
			coversWholeFile: startIndex === 0 && endIndex === lines.length,
		}
	}

	private enforceSelectedByteCount(selectedBytes: number): void {
		if (selectedBytes > MAX_TEXT_READ_SIZE) {
			throw new Error(
				`Selected text is ${selectedBytes} bytes, which exceeds the ${MAX_TEXT_READ_SIZE}-byte read limit. Specify a smaller line range.`,
			)
		}
	}

	private captureReadTelemetry(relPath: string, usedWorkspaceHint: boolean, env: IToolEnvironment): void {
		env.telemetry.captureCustomMetadata({
			path: relPath,
			isMultiRootEnabled: env.config.isMultiRootEnabled || false,
			usedWorkspaceHint,
			resolutionMethod: usedWorkspaceHint ? "hint" : "primary_fallback",
		})
	}

	private incrementMistakeCount(env: IToolEnvironment): void {
		env.orchestration.setTaskState("consecutiveMistakeCount", env.orchestration.getTaskState("consecutiveMistakeCount") + 1)
	}

	private updateTaskState(anySucceeded: boolean, env: IToolEnvironment): void {
		if (anySucceeded) env.orchestration.setTaskState("consecutiveMistakeCount", 0)
	}
}
