import * as vscode from "vscode"
import { sendAddToInputEvent } from "@/core/controller/ui/subscribeToAddToInput"
import { CommentThreadManager } from "./VscodeCommentThreadManager"
import { Logger } from "@/shared/services/Logger"

export type OnReplyCallback = (
	filePath: string,
	startLine: number,
	endLine: number,
	replyText: string,
	existingComments: string[],
	onChunk: (chunk: string) => void,
) => Promise<void>

export class CommentReplyHandler {
	constructor(
		private threadManager: CommentThreadManager,
		private onReplyCallback?: OnReplyCallback,
	) {}

	setOnReplyCallback(callback: OnReplyCallback): void {
		this.onReplyCallback = callback
	}

	async handleReply(reply: vscode.CommentReply): Promise<void> {
		const thread = reply.thread
		const replyText = reply.text

		const userComment = this.threadManager.createComment(replyText, vscode.CommentMode.Preview, true)
		thread.comments = [...thread.comments, userComment]

		if (this.onReplyCallback) {
			const filePath = this.threadManager.threadFilePathsMap.get(thread) || thread.uri.fsPath
			const startLine = thread.range.start.line
			const endLine = thread.range.end.line

			const existingComments = thread.comments.slice(0, -1).map((c) => {
				const author = c.author.name
				const body = typeof c.body === "string" ? c.body : c.body.value
				return `${author}: ${body}`
			})

			let streamingContent = ""
			const updateStreamingComment = (content: string) => {
				const streamingComment = this.threadManager.createComment(content || "_Thinking..._")
				thread.comments = [...thread.comments.slice(0, -1), streamingComment]
			}

			const thinkingComment = this.threadManager.createComment("_Thinking..._")
			thread.comments = [...thread.comments, thinkingComment]

			this.onReplyCallback(filePath, startLine, endLine, replyText, existingComments, (chunk) => {
				streamingContent += chunk
				updateStreamingComment(streamingContent)
			})
				.then(() => {
					if (streamingContent) {
						updateStreamingComment(streamingContent)
					}
				})
				.catch((error) => {
					const errorComment = this.threadManager.createComment(
						`_Error getting response: ${error instanceof Error ? error.message : "Unknown error"}_`,
					)
					thread.comments = [...thread.comments.slice(0, -1), errorComment]
				})
		}
	}

	async handleAddToChat(thread: vscode.CommentThread): Promise<void> {
		const filePath = this.threadManager.threadFilePathsMap.get(thread) || thread.uri.fsPath
		const startLine = thread.range.start.line + 1
		const endLine = thread.range.end.line + 1

		const conversation = thread.comments
			.map((c) => {
				const author = c.author.name === "You" ? "User" : c.author.name
				const body = typeof c.body === "string" ? c.body : c.body.value
				return `**${author}:** ${body}`
			})
			.join("\n\n")

		const contextMessage = `The following is a conversation from a code review comment on \`${filePath}\` (lines ${startLine}-${endLine}). The user would like to continue this discussion with you:

---

${conversation}

---

Please continue helping the user with their question about this code.`

		await sendAddToInputEvent(contextMessage)
	}

	async revealCommentInDocument(thread: vscode.CommentThread): Promise<void> {
		try {
			const doc = await vscode.workspace.openTextDocument(thread.uri)
			const commentPosition = new vscode.Range(thread.range.start, thread.range.start)
			const editor = await vscode.window.showTextDocument(doc, {
				selection: commentPosition,
				preserveFocus: false,
				preview: true,
			})
			editor.revealRange(commentPosition, vscode.TextEditorRevealType.InCenter)
		} catch (error) {
			Logger.error("[CommentReplyHandler] Error revealing comment:", error)
		}
	}
}
