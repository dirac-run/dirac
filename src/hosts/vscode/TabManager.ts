import { randomUUID } from "crypto"
import * as path from "path"
import * as vscode from "vscode"
import { Logger } from "@/shared/services/Logger"
import { arePathsEqual } from "@/utils/path"
import { DIFF_VIEW_URI_SCHEME } from "./diff-view-constants"

export interface TabManagerOptions {
	preserveFocus?: boolean
}

/** Tracks a provider's views, not all views of the same file or URI scheme. */
export class TabManager {
	readonly ownerId = randomUUID()
	readonly reviewTitle = `Review Dirac Edits (${this.ownerId})`

	originalUri(absolutePath: string, content: string): vscode.Uri {
		return vscode.Uri.file(absolutePath).with({
			scheme: DIFF_VIEW_URI_SCHEME,
			query: Buffer.from(content).toString("base64"),
			fragment: this.ownerId,
		})
	}

	async openDiffEditor(
		absolutePath: string,
		editType: "create" | "modify" | "delete" | undefined,
		originalContent: string | undefined,
		options?: TabManagerOptions,
	): Promise<{ editor: vscode.TextEditor; documentWasOpen: boolean }> {
		const uri = vscode.Uri.file(absolutePath)
		const documentWasOpen = vscode.window.tabGroups.all
			.flatMap((group) => group.tabs)
			.some((tab) => tab.input instanceof vscode.TabInputText && arePathsEqual(tab.input.uri.fsPath, uri.fsPath))
		const original = this.originalUri(absolutePath, originalContent ?? "")
		const editor = await this.openOwnedDiff(uri, original, editType === "modify", options?.preserveFocus ?? true)
		return { editor, documentWasOpen }
	}

	private async openOwnedDiff(
		uri: vscode.Uri,
		original: vscode.Uri,
		fileExists: boolean,
		preserveFocus: boolean,
	): Promise<vscode.TextEditor> {
		return new Promise<vscode.TextEditor>((resolve, reject) => {
			const disposables: vscode.Disposable[] = []
			const dispose = () => {
				clearTimeout(timeout)
				for (const disposable of disposables) disposable.dispose()
			}
			const findEditor = () => {
				const editor = vscode.window.visibleTextEditors.find((editor) => {
					if (editor.document.uri.toString() !== uri.toString()) return false
					const input = vscode.window.tabGroups.all.find((group) => group.viewColumn === editor.viewColumn)?.activeTab?.input
					return input instanceof vscode.TabInputTextDiff &&
						input.original.toString() === original.toString() && input.modified.toString() === uri.toString()
				})
				if (!editor) return
				dispose()
				resolve(editor)
			}
			const timeout = setTimeout(() => {
				dispose()
				reject(new Error("Failed to open diff editor, please try again..."))
			}, 10_000)
			disposables.push(
				vscode.window.onDidChangeVisibleTextEditors(findEditor),
				vscode.window.onDidChangeActiveTextEditor(findEditor),
			)
			void vscode.commands.executeCommand(
				"vscode.diff",
				original,
				uri,
				`${path.basename(uri.fsPath)}: ${fileExists ? "Original ↔ Dirac's Changes" : "New File"} (Editable)`,
				{ preserveFocus, preview: false },
			).then(findEditor, (error) => {
				dispose()
				reject(error)
			})
			findEditor()
		})
	}

	async closeOwnedDiffViews(): Promise<void> {
		const tabs = vscode.window.tabGroups.all
			.flatMap((group) => group.tabs)
			.filter((tab) => {
				if (tab.input instanceof vscode.TabInputTextDiff) {
					return tab.input.original.scheme === DIFF_VIEW_URI_SCHEME && tab.input.original.fragment === this.ownerId
				}
				// VS Code's stable API exposes multi-diff inputs as unknown. The command's
				// unique title identifies this provider's review without claiming other tabs.
				return tab.label === this.reviewTitle
			})
		// Presentation acknowledgements must not block saved edits or cancellation.
		tabs.filter((tab) => !tab.isDirty).forEach(async (tab) => {
			try {
				if (!(await vscode.window.tabGroups.close(tab))) {
					Logger.warn("TabManager: tab close refused:", tab.label)
				}
			} catch (error) {
				Logger.warn("TabManager: tab close failed:", error)
			}
		})
	}
}
