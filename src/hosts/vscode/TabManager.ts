import * as path from "path"
import * as vscode from "vscode"
import { Logger } from "@/shared/services/Logger"
import { arePathsEqual } from "@/utils/path"
import { DIFF_VIEW_URI_SCHEME } from "./diff-view-constants"

export interface TabManagerOptions {
	preserveFocus?: boolean
}

export class TabManager {
	private static closeTab(tab: vscode.Tab): void {
		if (!tab.isDirty) {
			try {
				vscode.window.tabGroups.close(tab)
			} catch (error) {
				Logger.warn("TabManager: tab close failed:", error instanceof Error ? error.message : String(error))
			}
		}
	}

	static async openDiffEditor(
		absolutePath: string,
		editType: "create" | "modify" | "delete" | undefined,
		originalContent: string | undefined,
		options?: TabManagerOptions,
	): Promise<{ editor: vscode.TextEditor; documentWasOpen: boolean }> {
		const uri = vscode.Uri.file(absolutePath)
		const fileExists = editType === "modify"

		const documentWasOpen = await this.closeExistingTabsForPath(uri)
		await this.closeExistingDiffTab(uri)
		const editor = await this.waitForActiveEditor(uri, fileExists, options?.preserveFocus ?? true, originalContent)

		return { editor, documentWasOpen }
	}

	private static async closeExistingTabsForPath(uri: vscode.Uri): Promise<boolean> {
		let documentWasOpen = false
		const tabs = vscode.window.tabGroups.all
			.flatMap((tg) => tg.tabs)
			.filter((tab) => tab.input instanceof vscode.TabInputText && arePathsEqual(tab.input.uri.fsPath, uri.fsPath))

		for (const tab of tabs) {
			if (!tab.isDirty) {
				this.closeTab(tab)
			}
			documentWasOpen = true
		}

		return documentWasOpen
	}

	private static async closeExistingDiffTab(uri: vscode.Uri): Promise<void> {
		const diffTab = vscode.window.tabGroups.all
			.flatMap((group) => group.tabs)
			.find(
				(tab) =>
					tab.input instanceof vscode.TabInputTextDiff &&
					tab.input?.original?.scheme === DIFF_VIEW_URI_SCHEME &&
					arePathsEqual(tab.input.modified.fsPath, uri.fsPath),
			)

		if (diffTab && diffTab.input instanceof vscode.TabInputTextDiff) {
			try {
				await vscode.window.tabGroups.close(diffTab)
			} catch (e) {
				Logger.error("TabManager: failed to close existing diff tab", e)
			}
		}
	}

	private static waitForActiveEditor(
		uri: vscode.Uri,
		fileExists: boolean,
		preserveFocus: boolean,
		originalContent: string | undefined,
	): Promise<vscode.TextEditor> {
		return new Promise<vscode.TextEditor>((resolve, reject) => {
			const fileName = path.basename(uri.fsPath)

			const disposable = vscode.window.onDidChangeActiveTextEditor((editor) => {
				if (editor && arePathsEqual(editor.document.uri.fsPath, uri.fsPath)) {
					disposable.dispose()
					resolve(editor)
				}
			})

			vscode.commands.executeCommand(
				"vscode.diff",
				uri.with({
					scheme: DIFF_VIEW_URI_SCHEME,
					query: Buffer.from(originalContent ?? "").toString("base64"),
				}),
				uri,
				`${fileName}: ${fileExists ? "Original \u2194 Dirac's Changes" : "New File"} (Editable)`,
				{ preserveFocus },
			)

			setTimeout(() => {
				disposable.dispose()
				reject(new Error("Failed to open diff editor, please try again..."))
			}, 10_000)
		})
	}

	static async closeAllDiffViews(scheme: string): Promise<void> {
		const tabs = vscode.window.tabGroups.all
			.flatMap((tg) => tg.tabs)
			.filter((tab) => tab.input instanceof vscode.TabInputTextDiff && tab.input?.original?.scheme === scheme)

		for (const tab of tabs) {
			if (!tab.isDirty) {
				this.closeTab(tab)
			}
		}
	}

	static async closeTabsByScheme(scheme: string): Promise<void> {
		const allTabs = vscode.window.tabGroups.all
			.flatMap((tg) => tg.tabs)
			.filter(
				(tab) =>
					(tab.input instanceof vscode.TabInputTextDiff && tab.input?.original?.scheme === scheme) ||
					(tab.input instanceof vscode.TabInputText && tab.input.uri.scheme === scheme),
			)

		for (const tab of allTabs) {
			try {
				await vscode.window.tabGroups.close(tab)
			} catch (_error) {
				Logger.warn("TabManager: failed to close tab", tab.input)
			}
		}
	}
}
