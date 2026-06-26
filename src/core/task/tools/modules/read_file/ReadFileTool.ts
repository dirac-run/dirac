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
		const { start_line, end_line } = args
		const includeAnchors = args.include_anchors === true
		const startLineNum = start_line ? Number(start_line) : undefined
		const endLineNum = end_line ? Number(end_line) : undefined

		if (paths.length === 0) {
			this.incrementMistakeCount(env)
			return formatResponse.toolError("Missing required parameter: paths")
		}

		if ((start_line && isNaN(startLineNum!)) || (end_line && isNaN(endLineNum!))) {
			throw new Error("Invalid line numbers. Please provide valid integers for start_line and end_line.")
		}

		if (startLineNum !== undefined && startLineNum < 1) {
			throw new Error("Invalid start_line: must be >= 1.")
		}
		if (endLineNum !== undefined && endLineNum < 1) {
			throw new Error("Invalid end_line: must be >= 1.")
		}
		if (startLineNum !== undefined && endLineNum !== undefined && startLineNum > endLineNum) {
			throw new Error(`Invalid line range: start_line ${startLineNum} cannot be greater than end_line ${endLineNum}.`)
		}

		const results: string[] = []
		const contentBlocks: any[] = []
		const fileHashes = env.context.task.get<Record<string, string>>("fileHashes") || {}

		let anySucceeded = false
		let anyFailed = false

		for (const relPath of paths) {
			const { success, result, contentBlock } = await this.readFileContent(
				relPath,
				paths.length > 1,
				startLineNum,
				endLineNum,
				fileHashes,
				env,
				includeAnchors,
			)
			if (success) {
				anySucceeded = true
			} else {
				anyFailed = true
			}
			results.push(result)
			if (contentBlock) {
				contentBlocks.push(contentBlock)
			}
		}

		this.updateTaskState(anySucceeded, anyFailed, env)
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
		startLineNum: number | undefined,
		endLineNum: number | undefined,
		fileHashes: Record<string, string>,
		env: IToolEnvironment,
		includeAnchors: boolean,
	): Promise<{ success: boolean; result: string; contentBlock?: any }> {
		const MAX_FILE_READ_SIZE = 50 * 1024 // 50KB
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

			card = !env.config.isSubagentExecution
				? await env.ui.createCard({
						header:
							startLineNum || endLineNum
								? `Reading lines ${startLineNum || 1}-${endLineNum || "end"} from ${displayPath}`
								: `Reading from ${displayPath}`,
						icon: DiracIcon.FILE_READ,
						collapsed: true,
					})
				: undefined

			if (!startLineNum && !endLineNum) {
				const info = await env.workspace.getFileInfo(absolutePath)
				if (info.isFile && info.size > MAX_FILE_READ_SIZE) {
					const msg = `The file size is ${Math.round(info.size / 1024)}KB, which exceeds the ${
						MAX_FILE_READ_SIZE / 1024
					}KB limit for full file reads. Reading this file will likely flood the context window. Please use more surgical means or specify a line range using 'start_line' and 'end_line' parameters.`
					if (card) {
						await card.update({ status: CardStatus.ERROR, body: `✕ ${msg}` })
						await card.finalize(CardStatus.ERROR)
					}
					return { success: false, result: `${header}${msg}` }
				}
			}

			const fileContent = await env.workspace.readRichFile(absolutePath)
			const contentBlock = fileContent.imageBlock

			const currentHash = contentHash(fileContent.text)
			const cacheKey = `${relPath}#${includeAnchors ? "anchored" : "plain"}`
			const lastHash = fileHashes[cacheKey]

			let resultText = ""
			if (lastHash === currentHash && !startLineNum && !endLineNum) {
				resultText = `${header}no changes have been made to the file since your last read (Hash: ${lastHash})`
				if (card) {
					await card.update({
						header: `Reading from ${displayPath} (no changes)`,
						status: CardStatus.SUCCESS,
						body: `✓ No changes since last read`,
					})
					await card.finalize(CardStatus.SUCCESS)
				}
			} else {
				const lines = fileContent.text.split(/\r?\n/)
				const anchors = AnchorStateManager.reconcile(absolutePath, lines, env.config.ulid)
				let formattedContent = includeAnchors ? formatLinesForModel(lines, anchors, true) : fileContent.text
				let totalLineCount: number | undefined
				if (startLineNum || endLineNum) {
					const contentLines = includeAnchors ? formattedContent.split("\n") : lines
					totalLineCount = contentLines.length
					const startLine = startLineNum || 1
					if (startLine > contentLines.length) {
						const msg = `start_line ${startLine} exceeds file length (${contentLines.length} lines). No content in specified range.`
						if (card) {
							await card.update({ status: CardStatus.ERROR, body: `✕ ${msg}` })
							await card.finalize(CardStatus.ERROR)
						}
						return { success: false, result: `${header}${msg}` }
					}
					const start = startLine - 1
					const end = Math.min(contentLines.length, endLineNum || contentLines.length)
					const sliced = contentLines.slice(start, end)
					formattedContent = sliced.join("\n")
				}
				const lineCountSuffix = totalLineCount !== undefined ? `\n[Total lines: ${totalLineCount}]` : ""
				resultText = `${header}[File Hash: ${currentHash}]${lineCountSuffix}\n${formattedContent}`
				fileHashes[cacheKey] = currentHash

				if (card) {
					const range =
						startLineNum || endLineNum ? `lines ${startLineNum || 1} to ${endLineNum || "end"}` : "full file"
					await card.update({
						header:
							startLineNum || endLineNum
								? `Read lines ${startLineNum || 1}-${endLineNum || "end"} from ${displayPath}`
								: `Read from ${displayPath}`,
						status: CardStatus.SUCCESS,
						body: `✓ Successfully read ${displayPath}${startLineNum || endLineNum ? ` (lines ${startLineNum || 1} to ${endLineNum || "end"})` : ""}`,
					})
					await card.finalize(CardStatus.SUCCESS)
				}
			}

			env.telemetry.captureCustomMetadata({
				path: relPath,
				isMultiRootEnabled: env.config.isMultiRootEnabled || false,
				usedWorkspaceHint,
				resolutionMethod: usedWorkspaceHint ? "hint" : "primary_fallback",
			})

			return { success: true, result: resultText, contentBlock }
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

	private incrementMistakeCount(env: IToolEnvironment): void {
		env.orchestration.setTaskState("consecutiveMistakeCount", env.orchestration.getTaskState("consecutiveMistakeCount") + 1)
	}

	private updateTaskState(anySucceeded: boolean, anyFailed: boolean, env: IToolEnvironment): void {
		// Only reset on success. Do NOT increment on failures here —
		// file-not-found is a valid outcome (the model provided correct arguments,
		// the file just doesn't exist). Missing-parameter mistakes are handled
		// separately above via incrementMistakeCount.
		if (anySucceeded) {
			env.orchestration.setTaskState("consecutiveMistakeCount", 0)
		}
	}
}
