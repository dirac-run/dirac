import * as vscode from "vscode"

const DIRAC_AVATAR_URL = "https://avatars.githubusercontent.com/u/184127137"

export class CommentThreadManager {
	private commentController: vscode.CommentController
	private threads: Map<string, vscode.CommentThread> = new Map()
	private threadFilePaths: Map<vscode.CommentThread, string> = new Map()

	constructor(controllerId: string, displayName: string) {
		this.commentController = vscode.comments.createCommentController(controllerId, displayName)

		this.commentController.options = {
			placeHolder: "Ask a question about this code...",
			prompt: "Reply to Dirac",
		}

		this.commentController.commentingRangeProvider = {
			provideCommentingRanges: (document: vscode.TextDocument): vscode.Range[] => {
				const lineCount = document.lineCount
				return [new vscode.Range(0, 0, lineCount - 1, 0)]
			},
		}
	}

	get controller(): vscode.CommentController {
		return this.commentController
	}

	get threadsMap(): Map<string, vscode.CommentThread> {
		return this.threads
	}

	get threadFilePathsMap(): Map<vscode.CommentThread, string> {
		return this.threadFilePaths
	}

	createComment(body: string, mode: vscode.CommentMode = vscode.CommentMode.Preview, isUser = false): vscode.Comment {
		return {
			body: new vscode.MarkdownString(body),
			mode,
			author: {
				name: isUser ? "You" : "Dirac",
				iconPath: isUser ? undefined : vscode.Uri.parse(DIRAC_AVATAR_URL),
			},
		}
	}

	createThread(uri: vscode.Uri, range: vscode.Range, comment: vscode.Comment): vscode.CommentThread {
		const thread = this.commentController.createCommentThread(uri, range, [comment])
		thread.canReply = true
		thread.collapsibleState = vscode.CommentThreadCollapsibleState.Expanded
		return thread
	}

	storeThread(threadKey: string, thread: vscode.CommentThread, filePath: string): void {
		this.threads.set(threadKey, thread)
		this.threadFilePaths.set(thread, filePath)
	}

	getThreadCount(): number {
		return this.threads.size
	}

	clearAllComments(): void {
		for (const thread of this.threads.values()) {
			this.threadFilePaths.delete(thread)
			thread.dispose()
		}
		this.threads.clear()
	}

	clearCommentsForFile(filePath: string): void {
		const keysToRemove: string[] = []
		for (const [key, thread] of this.threads.entries()) {
			if (key.startsWith(filePath + ":")) {
				this.threadFilePaths.delete(thread)
				thread.dispose()
				keysToRemove.push(key)
			}
		}
		for (const key of keysToRemove) {
			this.threads.delete(key)
		}
	}

	dispose(): void {
		this.clearAllComments()
		this.commentController.dispose()
	}
}
