import { Anthropic } from "@anthropic-ai/sdk"
import * as diff from "diff"
import * as path from "path"
import { Mode } from "@shared/storage/types"
import { DiracIgnoreController, LOCK_TEXT_SYMBOL } from "@core/ignore/DiracIgnoreController"
import type { FileInfo } from "@services/glob/list-files"

const CONTEXT_WINDOW_WARNING_THRESHOLD_PERCENT = 50

export const formatResponse = {
	duplicateFileReadNotice: () =>
		`[[NOTE] This file read has been removed to save space in the context window. Refer to the latest file read for the most up to date version of this file.]`,

	contextTruncationNotice: () =>
		`[NOTE] Some previous conversation history with the user has been removed to maintain optimal context window length. The initial user task has been retained for continuity, while intermediate conversation history has been removed. Keep this in mind as you continue assisting the user. Pay special attention to the user's latest messages.`,

	processFirstUserMessageForTruncation: () => {
		return "[Continue assisting the user!]"
	},

	toolDenied: () => `The user denied this operation.`,

	toolDeniedWithFeedback: (feedback: string) =>
		`The user denied this operation and provided the following feedback:\n<feedback>\n${feedback}\n</feedback>`,

	toolError: (error?: string) => `The tool execution failed with the following error:\n<error>\n${error}\n</error>`,

	toolTimeout: (toolName: string, operation: string, timeoutMs: number) =>
		`The tool execution timed out:\n<timeout>\nTool: ${toolName}\nLimit: ${timeoutMs / 1_000} seconds\nOperation: ${operation}\n</timeout>`,

	diracIgnoreError: (path: string) =>
		`Access to ${path} is blocked by the .diracignore file settings. You must try to continue in the task without using this file, or ask the user to update the .diracignore file.`,

	pathConflictError: (path: string) =>
		`Cannot write to '${path}' because one of the parent components is a file, not a directory.`,

	filePermissionError: (path: string, operation: string) =>
		`Cannot ${operation} '${path}': Permission denied. You may need to ask the user to check file permissions or try a different path.`,

	readOnlyError: (path: string) => `Cannot write to '${path}': Read-only file system.`,

	permissionDeniedError: (reason: string) =>
		`Command execution blocked by DIRAC_COMMAND_PERMISSIONS: ${reason}. You must try a different approach or ask the user to update the permission settings.`,

	noToolsUsed: (usingNativeToolCalls: boolean) =>
		`[PROTOCOL REMINDER] Your previous response did not include any tool calls. In ACT MODE, every response MUST include at least one tool call to move the task forward.

# Next Steps
- Use 'respond' with operation 'complete' if finished, 'question' for required input, or 'progress' for an update.
- Otherwise, proceed with the next step of the task using the appropriate tool.

(This is an automated message, so do not respond to it conversationally.)`,

	tooManyMistakes: (feedback?: string) =>
		`You seem to be having trouble proceeding. The user has provided the following feedback to help guide you:\n<feedback>\n${feedback}\n</feedback>`,

	missingToolParameterError: (paramName: string, example?: string) =>
		`Missing value for required parameter '${paramName}'. Please retry with complete response.${example ? `\n\nExample of correct usage (arguments JSON):\n${example}` : ""}\n`,

	/**
	 * Specialized error for write_to_file when the 'content' parameter is missing.
	 * Provides progressive guidance based on how many times this has happened consecutively,
	 * and includes token budget awareness to help the model understand output constraints.
	 */
	writeToFileMissingContentError: (relPath: string, consecutiveFailures: number, contextUsagePercent?: number): string => {
		const baseError = `Failed to write to '${relPath}': The 'content' parameter was empty. This typically happens when the file content is too large to generate in a single response, or when output token limits are reached before the content parameter is fully written.`

		const contextWarning =
			contextUsagePercent !== undefined && contextUsagePercent > CONTEXT_WINDOW_WARNING_THRESHOLD_PERCENT
				? `\n\nWarning: Context window is ${contextUsagePercent}% full. The remaining output budget may be insufficient for large file writes. You MUST use a strategy that produces smaller outputs.`
				: ""

		if (consecutiveFailures >= 3) {
			// After 3+ failures, be very directive — stop trying write_to_file entirely
			return (
				`${baseError}${contextWarning}\n\n` +
				`CRITICAL: You have failed to write this file ${consecutiveFailures} times in a row. You MUST change your approach — do NOT retry write_to_file for this file again.\n\n` +
				`Required action — choose ONE of these strategies:\n` +
				`1. **Create an empty file first, then use edit_file** to add content in small sections (recommended)\n` +
				`2. **Break the file into multiple smaller files** if architecturally appropriate\n` +
				`3. **Write a minimal skeleton** using write_to_file (just imports, class/function signatures, no implementations), then use edit_file to fill in each section one at a time\n\n` +
				`Each edit_file call should target a specific part of the file.`
			)
		}
		if (consecutiveFailures >= 2) {
			// After 2 failures, strongly suggest alternative approaches
			return (
				`${baseError}${contextWarning}\n\n` +
				`This is your ${consecutiveFailures}${consecutiveFailures === 2 ? "nd" : "rd"} failed attempt. The file content is likely too large to generate in one response. You must use a different strategy:\n\n` +
				`Recommended approaches:\n` +
				`1. **Use write_to_file with a minimal skeleton** (just the structure — imports, class/function signatures, no implementations), then use edit_file to fill in each section incrementally\n` +
				`2. **Use edit_file with smaller chunks** — if the file already exists, make targeted edits instead of rewriting the entire file\n` +
				`3. **Break the task into smaller steps** — write one function or section at a time\n\n` +
				`Do NOT attempt to write the full file content in a single write_to_file call again.`
			)
		}
		// First failure — provide helpful guidance
		return (
			`${baseError}${contextWarning}\n\n` +
			`Suggestions:\n` +
			`- If the file is large, try breaking down the task into smaller steps. Write a skeleton first, then fill in sections using edit_file.\n` +
			`- If the file already exists, prefer edit_file to make targeted edits instead of rewriting the entire file.\n` +
			`- Ensure the 'content' parameter contains the complete file content before closing the tool tag.\n\n`
		)
	},

	toolResult: (
		text: string,
		images?: string[],
		fileString?: string,
	): string | Array<Anthropic.TextBlockParam | Anthropic.ImageBlockParam> => {
		const toolResultOutput = []

		if (!(images && images.length > 0) && !fileString) {
			return text
		}

		const textBlock: Anthropic.TextBlockParam = { type: "text", text }
		toolResultOutput.push(textBlock)

		if (images && images.length > 0) {
			const imageBlocks: Anthropic.ImageBlockParam[] = formatImagesIntoBlocks(images)
			toolResultOutput.push(...imageBlocks)
		}

		if (fileString) {
			const fileBlock: Anthropic.TextBlockParam = { type: "text", text: fileString }
			toolResultOutput.push(fileBlock)
		}

		return toolResultOutput
	},

	imageBlocks: (images?: string[]): Anthropic.ImageBlockParam[] => {
		return formatImagesIntoBlocks(images)
	},

	formatFilesList: (
		absolutePath: string,
		files: FileInfo[],
		didHitLimit: boolean,
		diracIgnoreController?: DiracIgnoreController,
	): string => {
		const pathMap = new Map<string, FileInfo>(files.map((f) => [f.path, f]))

		const sorted = files.sort((a, b) => {
			const aParts = a.path.split("/")
			const bParts = b.path.split("/")
			for (let i = 0; i < Math.min(aParts.length, bParts.length); i++) {
				if (aParts[i] !== bParts[i]) {
					const aPathAtLevel = aParts.slice(0, i + 1).join("/") + (i + 1 < aParts.length ? "/" : "")
					const bPathAtLevel = bParts.slice(0, i + 1).join("/") + (i + 1 < bParts.length ? "/" : "")

					const aInfo = pathMap.get(aPathAtLevel)
					const bInfo = pathMap.get(bPathAtLevel)

					if (aInfo && bInfo) {
						if (bInfo.mtime !== aInfo.mtime) {
							return bInfo.mtime - aInfo.mtime // Newest first
						}
					}

					// Fallback to alphabetical
					return aParts[i].localeCompare(bParts[i], undefined, {
						numeric: true,
						sensitivity: "base",
					})
				}
			}
			return aParts.length - bParts.length
		})

		const filtered = diracIgnoreController ? sorted.filter((file) => diracIgnoreController.validateAccess(file.path)) : sorted

		const formatted = filtered.map((file) => {
			let relativePath = path.relative(absolutePath, file.path).toPosix()
			if (relativePath === "" && !file.isDirectory) {
				relativePath = path.basename(file.path)
			}
			const displayPath = file.isDirectory ? (relativePath.endsWith("/") ? relativePath : `${relativePath}/`) : relativePath
			const lineCountSuffix = file.lineCount !== undefined ? ` ${file.lineCount} lines` : ""
			return `${displayPath}${lineCountSuffix}`
		})

		const note = "[Note: Files are sorted by most recently modified first within each directory.]\n\n"

		if (formatted.length === 0 || (formatted.length === 1 && formatted[0] === "")) {
			return "No files found."
		}

		const totalCount = formatted.length
		const summary = didHitLimit
			? `${totalCount} elements listed below (limit reached):`
			: `${totalCount} out of ${totalCount} elements listed below:`

		if (didHitLimit) {
			return `${note}${summary}\n\n${formatted.join(
				"\n",
			)}\n\n(File list truncated. Use list_files on specific subdirectories if you need to explore further.)`
		}

		return `${note}${summary}\n\n${formatted.join("\n")}`
	},

	createPrettyPatch: (filename = "file", oldStr?: string, newStr?: string) => {
		// strings cannot be undefined or diff throws exception
		const patch = diff.createPatch(filename.toPosix(), oldStr || "", newStr || "")
		const lines = patch.split("\n")
		const prettyPatchLines = lines.slice(4)
		return prettyPatchLines.join("\n")
	},

	taskResumption: (
		mode: Mode,
		agoText: string,
		cwd: string,
		wasRecent: boolean | 0 | undefined,
		responseText?: string,
		hasPendingFileContextWarnings?: boolean,
	): [string, string] => {
		const taskResumptionMessage = wasRecent
			? ""
			: `[TASK RESUMPTION] (${agoText}) CWD: '${cwd.toPosix()}'\n\n${mode === "plan"
				? "Note: Assume any previous tool use without a result failed. You are in PLAN MODE; use respond with operation 'plan'. Avoid redundant text."
				: "Note: Assume any previous tool use without a result failed. Reassess the task context and continue if incomplete."
			}`

		const userResponseMessage = responseText
			? `${mode === "plan" ? "Respond to this message" : "New instructions"}:\n<user_message>\n${responseText}\n</user_message>`
			: mode === "plan"
				? "(The user did not provide a new message. Ask how to proceed or suggest switching to Act mode.)"
				: ""

		return [taskResumptionMessage, userResponseMessage]
	},

	planModeInstructions: () => {
		return `Research without modifying files. Answer simple questions directly. For implementation work, gather the necessary context and use \`respond\` with \`plan\` to present a concrete proposal. Ask the user to switch to Act Mode before implementing; you cannot switch modes yourself.`
	},

	fileEditWithUserChanges: (
		relPath: string,
		userEdits: string,
		autoFormattingEdits: string | undefined,
		newProblemsMessage: string | undefined,
	) =>
		[
			`Saved ${relPath.toPosix()}.`,
			`User changes (preserve these):\n${userEdits}`,
			autoFormattingEdits ? `Auto-formatting:\n${autoFormattingEdits}` : undefined,
			newProblemsMessage,
		].filter(Boolean).join("\n\n"),

	fileEditWithoutUserChanges: (
		relPath: string,
		autoFormattingEdits: string | undefined,
		newProblemsMessage: string | undefined,
	) =>
		[
			`Saved ${relPath.toPosix()}.`,
			autoFormattingEdits ? `Auto-formatting:\n${autoFormattingEdits}` : undefined,
			newProblemsMessage,
		].filter(Boolean).join("\n\n"),

	diracIgnoreInstructions: (content: string) =>
		`# .diracignore\n\n(The following is provided by a root-level .diracignore file where the user has specified files and directories that should not be accessed. When using list_files, you'll notice a ${LOCK_TEXT_SYMBOL} next to files that are blocked. Attempting to access the file's contents e.g. through read_file will result in an error.)\n\n${content}\n.diracignore`,

	diracRulesGlobalDirectoryInstructions: (globalDiracRulesFilePath: string, content: string) =>
		`# .diracrules/\n\nThe following is provided by a global .diracrules/ directory, located at ${globalDiracRulesFilePath.toPosix()}, where the user has specified instructions for all working directories:\n\n${content}`,

	diracRulesLocalDirectoryInstructions: (cwd: string, content: string) =>
		`# .diracrules/\n\nThe following is provided by a root-level .diracrules/ directory where the user has specified instructions for this working directory (${cwd.toPosix()})\n\n${content}`,

	diracRulesLocalFileInstructions: (cwd: string, content: string) =>
		`# .diracrules\n\nThe following is provided by a root-level .diracrules file where the user has specified instructions for this working directory (${cwd.toPosix()})\n\n${content}`,

	windsurfRulesLocalFileInstructions: (cwd: string, content: string) =>
		`# .windsurfrules\n\nThe following is provided by a root-level .windsurfrules file where the user has specified instructions for this working directory (${cwd.toPosix()})\n\n${content}`,

	cursorRulesLocalFileInstructions: (cwd: string, content: string) =>
		`# .cursorrules\n\nThe following is provided by a root-level .cursorrules file where the user has specified instructions for this working directory (${cwd.toPosix()})\n\n${content}`,

	cursorRulesLocalDirectoryInstructions: (cwd: string, content: string) =>
		`# .cursor/rules\n\nThe following is provided by a root-level .cursor/rules directory where the user has specified instructions for this working directory (${cwd.toPosix()})\n\n${content}`,

	agentsRulesLocalFileInstructions: (cwd: string, content: string) =>
		`# AGENTS.md\n\nThe following is provided by AGENTS.md files found recursively throughout this working directory (${cwd.toPosix()}) where the user has specified instructions. Nested AGENTS.md will be combined below, and you should only apply the instructions for each AGENTS.md file that is directly applicable to the current task, i.e. if you are reading or writing to a file in that directory.\n\n${content}`,

	fileContextWarning: (editedFiles: string[]): string => {
		return (
			`<explicit_instructions>\nExternally modified files:\n` +
			`${editedFiles.map((file) => ` ${path.resolve(file).toPosix()}`).join("\n")}\n` +
			`Read the current state before modifying these files; use include_anchors: true for edit_file coordinates.\n</explicit_instructions>`
		)
	},
}

// to avoid circular dependency
const formatImagesIntoBlocks = (images?: string[]): Anthropic.ImageBlockParam[] => {
	return images
		? images.map((dataUrl) => {
			// data:image/png;base64,base64string
			const [rest, base64] = dataUrl.split(",")
			const mimeType = rest.split(":")[1].split(";")[0]
			return {
				type: "image",
				source: {
					type: "base64",
					media_type: mimeType,
					data: base64,
				},
			} as Anthropic.ImageBlockParam
		})
		: []
}
