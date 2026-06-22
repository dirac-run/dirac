import * as vscode from "vscode"
import { arePathsEqual } from "@/utils/path"
import { DIFF_VIEW_URI_SCHEME } from "./diff-view-constants"

export class ReviewContextManager {
	private static reviewingFiles: Map<string, string> = new Map()
	private static contextKeyDisposables: vscode.Disposable[] = []
	private static isInitialized = false

	static initialize(): void {
		if (!ReviewContextManager.isInitialized) {
			ReviewContextManager.contextKeyDisposables.push(
				vscode.window.onDidChangeActiveTextEditor((editor) => ReviewContextManager.updateContextKeys(editor)),
				vscode.workspace.onDidChangeTextDocument((event) => {
					const activeEditor = vscode.window.activeTextEditor
					if (activeEditor && event.document === activeEditor.document) {
						ReviewContextManager.updateContextKeys(activeEditor)
					}
				}),
			)
			ReviewContextManager.isInitialized = true
		}
	}

	static dispose(): void {
		for (const disposable of ReviewContextManager.contextKeyDisposables) {
			disposable.dispose()
		}
		ReviewContextManager.contextKeyDisposables = []
		ReviewContextManager.isInitialized = false
	}

	private static updateContextKeys(editor: vscode.TextEditor | undefined): void {
		if (!editor || editor.document.uri.scheme === DIFF_VIEW_URI_SCHEME) {
			vscode.commands.executeCommand("setContext", "dirac.isFileUnderReview", false)
			vscode.commands.executeCommand("setContext", "dirac.isFileModified", false)
			return
		}

		const fsPath = editor.document.uri.fsPath
		let proposedContent: string | undefined
		for (const [filePath, content] of ReviewContextManager.reviewingFiles.entries()) {
			if (arePathsEqual(filePath, fsPath)) {
				proposedContent = content
				break
			}
		}

		if (proposedContent === undefined) {
			vscode.commands.executeCommand("setContext", "dirac.isFileUnderReview", false)
			vscode.commands.executeCommand("setContext", "dirac.isFileModified", false)
		} else {
			vscode.commands.executeCommand("setContext", "dirac.isFileUnderReview", true)
			const isModified = editor.document.getText() !== proposedContent
			vscode.commands.executeCommand("setContext", "dirac.isFileModified", isModified)
		}
	}

	static async showReview(
		files: { absolutePath: string; displayPath: string; content: string; originalContent?: string }[],
	): Promise<void> {
		ReviewContextManager.reviewingFiles = new Map(files.map((f) => [f.absolutePath, f.content]))
		ReviewContextManager.updateContextKeys(vscode.window.activeTextEditor)

		await vscode.commands.executeCommand(
			"vscode.changes",
			"Review Dirac Edits",
			files.map((file) => {
				const absolutePath = file.absolutePath.toPosix()
				return [
					vscode.Uri.file(file.absolutePath),
					vscode.Uri.parse(`${DIFF_VIEW_URI_SCHEME}:${absolutePath}`).with({
						query: Buffer.from(file.originalContent ?? "").toString("base64"),
					}),
					vscode.Uri.parse(`${DIFF_VIEW_URI_SCHEME}:${absolutePath}`).with({
						query: Buffer.from(file.content).toString("base64"),
					}),
				]
			}),
		)
		vscode.commands.executeCommand("workbench.action.closePanel")
	}

	static hideReview(): void {
		ReviewContextManager.reviewingFiles.clear()
		ReviewContextManager.updateContextKeys(vscode.window.activeTextEditor)
	}
}
