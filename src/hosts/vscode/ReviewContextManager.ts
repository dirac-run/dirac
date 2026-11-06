import * as vscode from "vscode"
import type { EditorReviewRequest } from "@shared/editorReview"
import { TabManager } from "./TabManager"

export class ReviewContextManager {
	private reviewingFiles = new Map<string, string>()
	private request?: EditorReviewRequest
	private static reviews = new Set<ReviewContextManager>()
	private static contextKeyDisposables: vscode.Disposable[] = []

	constructor(private readonly tabs: TabManager) {}

	private static initialize(): void {
		if (this.contextKeyDisposables.length > 0) return
		this.contextKeyDisposables.push(
			vscode.window.onDidChangeActiveTextEditor((editor) => this.updateContextKeys(editor)),
			vscode.workspace.onDidChangeTextDocument((event) => {
				const activeEditor = vscode.window.activeTextEditor
				if (activeEditor && event.document === activeEditor.document) this.updateContextKeys(activeEditor)
			}),
		)
	}

	/** Resolve only a registered preview URI, never whichever conversation currently waits. */
	static getRequest(
		uri: vscode.Uri | undefined = vscode.window.activeTextEditor?.document.uri,
	): EditorReviewRequest | undefined {
		if (!uri) return undefined
		const review = [...this.reviews].find((candidate) => candidate.reviewingFiles.has(uri.toString()))
		return review?.request ? { ...review.request } : undefined
	}

	private static updateContextKeys(editor: vscode.TextEditor | undefined): void {
		const uri = editor?.document.uri
		const review = uri && [...this.reviews].find((candidate) => candidate.reviewingFiles.has(uri.toString()))
		const actionable = review?.request !== undefined
		const proposedContent = uri && review?.reviewingFiles.get(uri.toString())
		vscode.commands.executeCommand("setContext", "dirac.isFileUnderReview", actionable)
		vscode.commands.executeCommand(
			"setContext",
			"dirac.isFileModified",
			actionable && proposedContent !== editor!.document.getText(),
		)
	}

	async showReview(
		files: { absolutePath: string; displayPath: string; content: string; originalContent?: string }[],
		request?: EditorReviewRequest,
	): Promise<void> {
		if (request && (!request.taskId || !request.cardId)) throw new Error("Editor review requires an exact task and card")
		this.request = request ? { ...request } : undefined
		const changes = files.map((file) => {
			const original = this.tabs.originalUri(file.absolutePath, file.originalContent ?? "", request?.cardId)
			const proposed = this.tabs.originalUri(file.absolutePath, file.content, request?.cardId)
			return { file, original, proposed }
		})
		this.reviewingFiles = new Map(
			changes.flatMap(({ file, original, proposed }) => [
				[original.toString(), file.content],
				[proposed.toString(), file.content],
			]),
		)
		ReviewContextManager.reviews.add(this)
		ReviewContextManager.initialize()
		ReviewContextManager.updateContextKeys(vscode.window.activeTextEditor)

		await vscode.commands.executeCommand(
			"vscode.changes",
			this.tabs.reviewTitle,
			changes.map(({ file, original, proposed }) => [vscode.Uri.file(file.absolutePath), original, proposed]),
		)
		vscode.commands.executeCommand("workbench.action.closePanel")
	}

	hideReview(): void {
		this.reviewingFiles.clear()
		this.request = undefined
		ReviewContextManager.reviews.delete(this)
		ReviewContextManager.updateContextKeys(vscode.window.activeTextEditor)
		if (ReviewContextManager.reviews.size === 0) {
			for (const disposable of ReviewContextManager.contextKeyDisposables) disposable.dispose()
			ReviewContextManager.contextKeyDisposables = []
		}
	}
}
