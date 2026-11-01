import * as vscode from "vscode"
import { arePathsEqual } from "@/utils/path"
import { DIFF_VIEW_URI_SCHEME } from "./diff-view-constants"
import { TabManager } from "./TabManager"

export class ReviewContextManager {
	private reviewingFiles = new Map<string, string>()
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

	private static updateContextKeys(editor: vscode.TextEditor | undefined): void {
		const proposedContents =
			editor && editor.document.uri.scheme !== DIFF_VIEW_URI_SCHEME
				? [...this.reviews].flatMap((review) =>
						[...review.reviewingFiles]
							.filter(([filePath]) => arePathsEqual(filePath, editor.document.uri.fsPath))
							.map(([, content]) => content),
					)
				: []
		vscode.commands.executeCommand("setContext", "dirac.isFileUnderReview", proposedContents.length > 0)
		vscode.commands.executeCommand(
			"setContext",
			"dirac.isFileModified",
			proposedContents.some((content) => content !== editor!.document.getText()),
		)
	}

	async showReview(
		files: { absolutePath: string; displayPath: string; content: string; originalContent?: string }[],
	): Promise<void> {
		this.reviewingFiles = new Map(files.map((file) => [file.absolutePath, file.content]))
		ReviewContextManager.reviews.add(this)
		ReviewContextManager.initialize()
		ReviewContextManager.updateContextKeys(vscode.window.activeTextEditor)

		await vscode.commands.executeCommand(
			"vscode.changes",
			this.tabs.reviewTitle,
			files.map((file) => [
				vscode.Uri.file(file.absolutePath),
				this.tabs.originalUri(file.absolutePath, file.originalContent ?? ""),
				this.tabs.originalUri(file.absolutePath, file.content),
			]),
		)
		vscode.commands.executeCommand("workbench.action.closePanel")
	}

	hideReview(): void {
		this.reviewingFiles.clear()
		ReviewContextManager.reviews.delete(this)
		ReviewContextManager.updateContextKeys(vscode.window.activeTextEditor)
		if (ReviewContextManager.reviews.size === 0) {
			for (const disposable of ReviewContextManager.contextKeyDisposables) disposable.dispose()
			ReviewContextManager.contextKeyDisposables = []
		}
	}
}
