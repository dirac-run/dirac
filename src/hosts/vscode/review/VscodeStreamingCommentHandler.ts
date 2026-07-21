import * as vscode from "vscode"
import { DIFF_VIEW_URI_SCHEME } from "../diff-view-constants"
import { CommentThreadManager } from "./VscodeCommentThreadManager"

export class StreamingCommentHandler {
	private streamingThread: vscode.CommentThread | null = null
	private streamingContent = ""

	constructor(private threadManager: CommentThreadManager) {}

	startStreaming(
		filePath: string,
		startLine: number,
		endLine: number,
		relativePath?: string,
		fileContent?: string,
		revealComment = false,
	): void {
		const uri = this.buildUri(filePath, relativePath, fileContent)
		const range = new vscode.Range(new vscode.Position(startLine, 0), new vscode.Position(endLine, Number.MAX_SAFE_INTEGER))

		const commentObj = this.threadManager.createComment("_Thinking..._")
		const thread = this.threadManager.createThread(uri, range, commentObj)

		this.streamingThread = thread
		this.streamingContent = ""

		const threadKey = this.getThreadKey(filePath, startLine, endLine)
		this.threadManager.storeThread(threadKey, thread, filePath)

		if (revealComment) {
			this.revealInDocument(thread)
		}
	}

	appendChunk(chunk: string): void {
		if (!this.streamingThread) {
			return
		}

		this.streamingContent += chunk

		const commentObj = this.threadManager.createComment(this.streamingContent || "_Thinking..._")
		this.streamingThread.comments = [...[commentObj]]
	}

	endStreaming(): void {
		if (!this.streamingThread) {
			return
		}

		const finalContent = this.streamingContent.trim() || "_No comment generated_"
		const commentObj = this.threadManager.createComment(finalContent)
		this.streamingThread.comments = [commentObj]

		this.streamingThread = null
		this.streamingContent = ""
	}

	get isStreaming(): boolean {
		return this.streamingThread !== null
	}

	private async revealInDocument(thread: vscode.CommentThread): Promise<void> {
		try {
			const range = this.requireThreadRange(thread)
			const doc = await vscode.workspace.openTextDocument(thread.uri)
			const commentPosition = new vscode.Range(range.start, range.start)
			const editor = await vscode.window.showTextDocument(doc, {
				selection: commentPosition,
				preserveFocus: false,
				preview: true,
			})
			editor.revealRange(commentPosition, vscode.TextEditorRevealType.InCenter)
		} catch (_error) {
			// Ignore errors - this is not critical
		}
	}
	private requireThreadRange(thread: vscode.CommentThread): vscode.Range {
		if (!thread.range) throw new Error("Streaming comment thread has no document range")
		return thread.range
	}

	private getThreadKey(filePath: string, startLine: number, endLine: number): string {
		return `${filePath}:${startLine}:${endLine}`
	}

	private buildUri(filePath: string, relativePath?: string, fileContent?: string): vscode.Uri {
		if (relativePath && fileContent !== undefined) {
			return vscode.Uri.parse(`${DIFF_VIEW_URI_SCHEME}:${relativePath}`).with({
				query: Buffer.from(fileContent).toString("base64"),
			})
		}
		return vscode.Uri.file(filePath)
	}
}
