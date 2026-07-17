import { IDiracTool } from "../../interfaces/IDiracTool"
import { IToolEnvironment } from "../../interfaces/IToolEnvironment"
import { DiracIcon } from "@/shared/icons"
import { DiracToolSpec, DiracDefaultTool } from "@/shared/tools"
import { formatResponse } from "@core/formatResponse"
import { SurfaceType } from "../../interfaces/SurfaceType"
import { contentHash, formatLinesForModel } from "@utils/line-hashing"
import { AnchorStateManager } from "@utils/AnchorStateManager"
import { CardStatus } from "@/shared/ExtensionMessage"

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

const MAX_TEXT_READ_SIZE = 50 * 1024

export const read_file_spec: DiracToolSpec = {
	id: DiracDefaultTool.FILE_READ,
	name: "read_file",
	description:
		'Reads the complete contents of one or more files at the specified paths. Automatically extracts raw text from PDF and DOCX files. Returns the hash anchored lines that you can use with the edit_file tool. You can also specify a line range to read only a specific part of the file(s). Examples: { paths: ["src/main.ts", "package.json"] }, { paths: ["src/main.ts"] }, { paths: ["src/main.ts"], start_line: 10, end_line: 50 }, { paths: ["src/main.ts"], start_line: 100 }, { paths: ["src/main.ts"], end_line: 50 }. Consider using surgical tools like get_file_skeleton or get_function over this.',
	parameters: [
		{
			name: "paths",
			required: true,
			type: "array",
			items: { type: "string" },
			instruction: "An array of relative paths to the source files.",
			usage: '["src/utils/math.ts", "src/utils/string.ts"]',
		},
		{
			name: "start_line",
			required: false,
			type: "integer",
			instruction: "Optional. If not supplied, output will start from line 1.",
			usage: "10",
		},
		{
			name: "end_line",
			required: false,
			type: "integer",
			instruction: "Optional. If not supplied, the output will go until the last line",
			usage: "50",
		},
		{
			name: "include_anchors",
			required: false,
			type: "boolean",
			instruction:
				"Optional. When true, returns source lines prefixed with stable hash anchors usable by edit_file. Default false.",
			usage: "true",
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
		const results: string[] = []
		const contentBlocks: any[] = []
		const fileHashes = env.context.task.get<Record<string, string>>("fileHashes") || {}
		let anySucceeded = false

		for (const relPath of paths) {
			const { success, result, contentBlock } = await this.readFileContent(
				relPath,
				paths.length > 1,
				lineRange,
				fileHashes,
				env,
				args.include_anchors === true,
			)
			anySucceeded ||= success
			results.push(result)
			if (contentBlock) {
				contentBlocks.push(contentBlock)
			}
		}

		this.updateTaskState(anySucceeded, env)
		await env.context.task.set("fileHashes", fileHashes)

		const finalResultText = results.join("\n\n")
		if (contentBlocks.length > 0) {
			return [{ type: "text", text: finalResultText }, ...contentBlocks]
		}

		return finalResultText
	}

	private async readFileContent(
		relPath: string,
		isMultiFile: boolean,
		lineRange: LineRange | undefined,
		fileHashes: Record<string, string>,
		env: IToolEnvironment,
		includeAnchors: boolean,
	): Promise<{ success: boolean; result: string; contentBlock?: any }> {
		const header = isMultiFile ? `--- ${relPath} ---\n` : ""
		let absolutePath = ""
		let displayPath = relPath
		let usedWorkspaceHint = false
		let card: any | undefined

		try {
			const resolved = await env.workspace.resolvePath(relPath)
			absolutePath = resolved.absolutePath
			displayPath = resolved.displayPath
			usedWorkspaceHint = displayPath !== relPath

			const rangeLabel = lineRange ? `lines ${lineRange.start}-${lineRange.end ?? "end"}` : undefined
			card = !env.config.isSubagentExecution
				? await env.ui.createCard({
					header: rangeLabel ? `Reading ${rangeLabel} from ${displayPath}` : `Reading from ${displayPath}`,
					icon: DiracIcon.FILE_READ,
					collapsed: true,
				})
				: undefined

			const fileContent = await env.workspace.readRichFile(absolutePath)
			if (fileContent.imageBlock) {
				if (card) {
					await card.update({
						header: `Read image from ${displayPath}`,
						status: CardStatus.SUCCESS,
						body: `✓ Successfully read ${displayPath}`,
					})
					await card.finalize(CardStatus.SUCCESS)
				}
				this.captureReadTelemetry(relPath, usedWorkspaceHint, env)
				return { success: true, result: `${header}${fileContent.text}`, contentBlock: fileContent.imageBlock }
			}

			const selection = this.selectText(fileContent.text, lineRange)
			this.enforceTextReadSize(selection.text)

			const currentHash = contentHash(fileContent.text)
			const cacheKey = `${absolutePath}#${includeAnchors ? "anchored" : "plain"}`
			if (selection.coversWholeFile && fileHashes[cacheKey] === currentHash) {
				const result = `${header}no changes have been made to the file since your last read (Hash: ${currentHash})`
				if (card) {
					await card.update({
						header: `Reading from ${displayPath} (no changes)`,
						status: CardStatus.SUCCESS,
						body: "✓ No changes since last read",
					})
					await card.finalize(CardStatus.SUCCESS)
				}
				this.captureReadTelemetry(relPath, usedWorkspaceHint, env)
				return { success: true, result }
			}

			let formattedContent = selection.text
			if (includeAnchors) {
				const allLines = fileContent.text.split(/\r?\n/)
				const anchors = AnchorStateManager.reconcile(absolutePath, allLines, env.config.ulid)
				formattedContent = formatLinesForModel(selection.lines, anchors.slice(selection.startIndex, selection.endIndex), true)
			}

			const lineCountSuffix = lineRange ? `\n[Total lines: ${selection.totalLineCount}]` : ""
			const result = `${header}[File Hash: ${currentHash}]${lineCountSuffix}\n${formattedContent}`

			if (card) {
				await card.update({
					header: rangeLabel ? `Read ${rangeLabel} from ${displayPath}` : `Read from ${displayPath}`,
					status: CardStatus.SUCCESS,
					body: `✓ Successfully read ${displayPath}${rangeLabel ? ` (${rangeLabel})` : ""}`,
				})
				await card.finalize(CardStatus.SUCCESS)
			}

			if (selection.coversWholeFile) {
				fileHashes[cacheKey] = currentHash
			}
			this.captureReadTelemetry(relPath, usedWorkspaceHint, env)
			return { success: true, result }
		} catch (error: any) {
			const errorMessage = error instanceof Error ? error.message : String(error)
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
	private parseLineRange(startLine: number | undefined, endLine: number | undefined): LineRange | undefined {
		if (startLine === undefined && endLine === undefined) {
			return undefined
		}

		const parseLineNumber = (name: string, value: number | undefined): number | undefined => {
			if (value === undefined) {
				return undefined
			}
			const parsed = Number(value)
			if (!Number.isInteger(parsed) || parsed < 1) {
				throw new Error(`Invalid ${name}: must be an integer >= 1.`)
			}
			return parsed
		}

		const start = parseLineNumber("start_line", startLine) ?? 1
		const end = parseLineNumber("end_line", endLine)
		if (end !== undefined && start > end) {
			throw new Error(`Invalid line range: start_line ${start} cannot be greater than end_line ${end}.`)
		}
		return { start, end }
	}

	private selectText(text: string, lineRange: LineRange | undefined): TextSelection {
		const lines = text.split(/\r?\n/)
		if (!lineRange) {
			return {
				text,
				lines,
				totalLineCount: lines.length,
				startIndex: 0,
				endIndex: lines.length,
				coversWholeFile: true,
			}
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

	private enforceTextReadSize(text: string): void {
		const selectedBytes = Buffer.byteLength(text, "utf8")
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
		// Only reset on success. File-level failures are valid outcomes; missing
		// parameters are counted separately before file processing begins.
		if (anySucceeded) {
			env.orchestration.setTaskState("consecutiveMistakeCount", 0)
		}
	}
}
