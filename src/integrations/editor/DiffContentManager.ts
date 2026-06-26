import { formatResponse } from "@core/formatResponse"
import { sanitizeNotebookForLLM } from "../misc/notebook-utils"

// Use require to avoid ts-node transpileOnly eliding the import
const diffLib = require("diff") as typeof import("diff")

const UPDATE_THROTTLE_MS = 100

export class DiffContentManager {
	private streamedLines: string[] = []
	private lastUpdateContentLength = -1
	private lastUpdateTime = 0

	constructor(private relPath?: string) {}

	async update(
		content: string,
		isFinal: boolean,
		onReplaceText: (content: string, range: { startLine: number; endLine: number }) => Promise<void>,
		onScrollToLine: (line: number) => Promise<void>,
		getDocumentLineCount: () => Promise<number>,
		onScrollAnimation?: (start: number, end: number) => Promise<void>,
	): Promise<{ lineCount: number }> {
		if (!isFinal) {
			const now = Date.now()
			const contentLength = content.length
			const timeSinceLastUpdate = now - this.lastUpdateTime

			if (contentLength === 0 || contentLength === this.lastUpdateContentLength) {
				return { lineCount: this.streamedLines.length }
			}
			if (timeSinceLastUpdate < UPDATE_THROTTLE_MS) {
				return { lineCount: this.streamedLines.length }
			}

			this.lastUpdateContentLength = contentLength
			this.lastUpdateTime = now
		}

		let processedContent = content
		if (processedContent.startsWith("\ufeff")) {
			processedContent = processedContent.slice(1)
		}

		const accumulatedLines = processedContent.split("\n")
		if (!isFinal) {
			accumulatedLines.pop()
		}

		const diffLines = accumulatedLines.slice(this.streamedLines.length)
		const currentLine = this.streamedLines.length + diffLines.length - 1

		if (currentLine >= 0) {
			let contentToReplace = accumulatedLines.slice(0, currentLine + 1).join("\n")
			if (!isFinal) {
				contentToReplace += "\n"
			}

			const endLine = isFinal ? await getDocumentLineCount() : currentLine + 1
			await onReplaceText(contentToReplace, { startLine: 0, endLine })

			if (diffLines.length <= 5) {
				await onScrollToLine(currentLine)
			} else if (onScrollAnimation) {
				const startLine = this.streamedLines.length
				await onScrollAnimation(startLine, currentLine)
				await onScrollToLine(currentLine)
			} else {
				await onScrollToLine(currentLine)
			}
		}

		this.streamedLines = accumulatedLines
		return { lineCount: this.streamedLines.length }
	}

	async finalize(onTruncate: (lineNumber: number) => Promise<void>): Promise<void> {
		await onTruncate(this.streamedLines.length)
	}

	reset(): void {
		this.streamedLines = []
		this.lastUpdateContentLength = -1
		this.lastUpdateTime = 0
	}

	getAccumulatedContent(): string {
		return this.streamedLines.join("\n")
	}

	async scrollToFirstDiff(
		originalContent: string,
		onGetDocumentText: () => Promise<string | undefined>,
		onScrollToLine: (line: number) => Promise<void>,
	): Promise<void> {
		const currentContent = (await onGetDocumentText()) || ""
		const diffs = this.computeDiffLines(originalContent, currentContent)

		let lineCount = 0
		for (const part of diffs) {
			if (part.added || part.removed) {
				await onScrollToLine(lineCount)
				return
			}
			if (!part.removed) {
				lineCount += part.count || 0
			}
		}
	}

	// Use the diff library's diffLines for accurate change detection with grouping
	private computeDiffLines(a: string, b: string): import("diff").Change[] {
		return diffLib.diffLines(a, b)
	}

	normalizeEol(text: string): string {
		const newContentEOL = text.includes("\r\n") ? "\r\n" : "\n"
		return text.replace(/\r\n|\n/g, newContentEOL).trimEnd() + newContentEOL
	}

	detectUserEdits(newContent: string, preSaveContent: string, relPath?: string): string | undefined {
		const normalizedPre = this.normalizeEol(preSaveContent)
		const normalizedNew = this.normalizeEol(newContent)
		if (normalizedPre !== normalizedNew) {
			return formatResponse.createPrettyPatch((relPath || "file").toPosix(), normalizedNew, normalizedPre)
		}
		return undefined
	}

	detectAutoFormattingEdits(preSaveContent: string, postSaveContent: string, relPath?: string): string | undefined {
		const normalizedPre = this.normalizeEol(preSaveContent)
		const normalizedPost = this.normalizeEol(postSaveContent)
		if (normalizedPre !== normalizedPost) {
			return formatResponse.createPrettyPatch((relPath || "file").toPosix(), normalizedPre, normalizedPost)
		}
		return undefined
	}

	getFinalContent(postSaveContent: string, isNotebookFile: boolean): string {
		const normalized = this.normalizeEol(postSaveContent)
		return isNotebookFile ? sanitizeNotebookForLLM(normalized, true) : normalized
	}

	setRelPath(relPath: string | undefined): void {
		this.relPath = relPath
	}
}
