import * as vscode from "vscode"
import { CommentReviewController, type OnReplyCallback, type ReviewComment } from "@/integrations/editor/CommentReviewController"
import { DIFF_VIEW_URI_SCHEME } from "../diff-view-constants"
import { CommentReplyHandler, type OnReplyCallback as ReplyCallback } from "./VscodeCommentReplyHandler"
import { CommentThreadManager } from "./VscodeCommentThreadManager"
import { StreamingCommentHandler } from "./VscodeStreamingCommentHandler"

export class VscodeCommentReviewController extends CommentReviewController implements vscode.Disposable {
	private readonly disposables: vscode.Disposable[] = []
	private threadManager = new CommentThreadManager("dirac-ai-review", "Dirac AI Review")
	private streamingHandler: StreamingCommentHandler
	private replyHandler: CommentReplyHandler

	constructor() {
		super()
		this.streamingHandler = new StreamingCommentHandler(this.threadManager)
		this.replyHandler = new CommentReplyHandler(this.threadManager)
		this.registerCommands()
	}

	private registerCommands(): void {
		// Register commands and track disposals so they're cleaned up with the controller
		this.disposables.push(
			vscode.commands.registerCommand("dirac.reviewComment.reply", async (reply: vscode.CommentReply) => {
				await this.replyHandler.handleReply(reply)
			}),
		)
		this.disposables.push(
			vscode.commands.registerCommand("dirac.reviewComment.addToChat", async (thread: vscode.CommentThread) => {
				await this.replyHandler.handleAddToChat(thread)
			}),
		)
	}

	setOnReplyCallback(callback: OnReplyCallback): void {
		this.replyHandler.setOnReplyCallback(callback as ReplyCallback)
	}

	async ensureCommentsViewDisabled(): Promise<void> {
		const config = vscode.workspace.getConfiguration("comments")
		const currentValue = config.get<string>("openView")
		if (currentValue !== "never") {
			await config.update("openView", "never", vscode.ConfigurationTarget.Global)
		}
	}

	addReviewComment(comment: ReviewComment): void {
		const uri = this.buildUri(comment.relativePath, comment.filePath, comment.fileContent)
		const range = new vscode.Range(
			new vscode.Position(comment.startLine, 0),
			new vscode.Position(comment.endLine, Number.MAX_SAFE_INTEGER),
		)

		const commentObj = this.threadManager.createComment(comment.comment)
		const thread = this.threadManager.createThread(uri, range, commentObj)

		const threadKey = `${comment.filePath}:${comment.startLine}:${comment.endLine}`
		this.threadManager.storeThread(threadKey, thread, comment.filePath)
	}

	startStreamingComment(
		filePath: string,
		startLine: number,
		endLine: number,
		relativePath?: string,
		fileContent?: string,
		revealComment = false,
	): void {
		this.streamingHandler.startStreaming(filePath, startLine, endLine, relativePath, fileContent, revealComment)
	}

	appendToStreamingComment(chunk: string): void {
		this.streamingHandler.appendChunk(chunk)
	}

	endStreamingComment(): void {
		this.streamingHandler.endStreaming()
	}

	addReviewComments(comments: ReviewComment[]): void {
		comments.forEach((comment) => this.addReviewComment(comment))
	}

	clearAllComments(): void {
		this.threadManager.clearAllComments()
	}

	clearCommentsForFile(filePath: string): void {
		this.threadManager.clearCommentsForFile(filePath)
	}

	getThreadCount(): number {
		return this.threadManager.getThreadCount()
	}

	async closeDiffViews(): Promise<void> {
		const tabs = vscode.window.tabGroups.all
			.flatMap((tg) => tg.tabs)
			.filter(
				(tab) =>
					(tab.input instanceof vscode.TabInputTextDiff && tab.input?.original?.scheme === DIFF_VIEW_URI_SCHEME) ||
					(tab.input instanceof vscode.TabInputText && tab.input?.uri?.scheme === DIFF_VIEW_URI_SCHEME),
			)

		for (const tab of tabs) {
			try {
				await vscode.window.tabGroups.close(tab)
			} catch (_error) {
				// Tab might already be closed
			}
		}
	}

	dispose(): void {
		this.threadManager.dispose()
		this.disposables.forEach((d) => d.dispose())
	}

	private buildUri(relativePath: string | undefined, filePath: string, fileContent: string | undefined): vscode.Uri {
		if (relativePath && fileContent !== undefined) {
			return vscode.Uri.parse(`${DIFF_VIEW_URI_SCHEME}:${relativePath}`).with({
				query: Buffer.from(fileContent).toString("base64"),
			})
		}
		return vscode.Uri.file(filePath)
	}
}

// Singleton instance for the extension
let instance: VscodeCommentReviewController | undefined

export function getVscodeCommentReviewController(): VscodeCommentReviewController {
	if (!instance) {
		instance = new VscodeCommentReviewController()
	}
	return instance
}

export function disposeVscodeCommentReviewController(): void {
	if (instance) {
		instance.dispose()
		instance = undefined
	}
}
