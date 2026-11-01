import { DiffViewProvider } from "@integrations/editor/DiffViewProvider"
import * as vscode from "vscode"
import { DecorationControllerManager } from "@/hosts/vscode/DecorationControllerManager"
import { DocumentOperationManager } from "@/hosts/vscode/DocumentOperationManager"
import { NotebookDiffManager } from "@/hosts/vscode/NotebookDiffManager"
import { ReviewContextManager } from "@/hosts/vscode/ReviewContextManager"
import { StreamingTextUpdater } from "@/hosts/vscode/StreamingTextUpdater"
import { TabManager } from "@/hosts/vscode/TabManager"
import { DIFF_VIEW_URI_SCHEME } from "./diff-view-constants"

export { DIFF_VIEW_URI_SCHEME }

export class VscodeDiffViewProvider extends DiffViewProvider {
	private decorationManager?: DecorationControllerManager
	private streamingUpdater?: StreamingTextUpdater
	private notebookManager = new NotebookDiffManager()
	private documentOpManager = new DocumentOperationManager()
	private readonly tabManager = new TabManager()
	private readonly reviewManager = new ReviewContextManager(this.tabManager)
	private diffEditor?: vscode.TextEditor

	override async openDiffEditor(): Promise<void> {
		if (!this.absolutePath) {
			throw new Error("No file path set")
		}

		this.documentWasOpen = false

		const { editor, documentWasOpen } = await this.tabManager.openDiffEditor(
			this.absolutePath,
			this.editType,
			this.originalContent,
			{ preserveFocus: true },
		)
		if (!this.isEditing) return
		this.documentWasOpen = documentWasOpen
		this.diffEditor = editor

		this.decorationManager = new DecorationControllerManager(editor)
		this.decorationManager.initialize()

		this.streamingUpdater = new StreamingTextUpdater(editor)
	}

	override async replaceText(
		content: string,
		rangeToReplace: { startLine: number; endLine: number },
		currentLine: number | undefined,
	): Promise<void> {
		if (!this.streamingUpdater) {
			throw new Error("User closed text editor, unable to edit file...")
		}

		await this.streamingUpdater.replaceText(content, rangeToReplace, currentLine)

		if (currentLine !== undefined && this.decorationManager) {
			this.decorationManager.updateAfterReplace(currentLine)
		}
	}

	override async scrollEditorToLine(line: number): Promise<void> {
		await this.streamingUpdater?.scrollEditorToLine(line)
	}

	override async scrollAnimation(startLine: number, endLine: number): Promise<void> {
		await this.streamingUpdater?.scrollAnimation(startLine, endLine)
	}

	override async truncateDocument(lineNumber: number): Promise<void> {
		await this.streamingUpdater?.truncateDocument(lineNumber)
	}

	protected override async onFinalUpdate(): Promise<void> {
		this.decorationManager?.clearAll()
	}

	protected override async getDocumentLineCount(): Promise<number> {
		return this.streamingUpdater?.lineCount ?? 0
	}

	protected override async getDocumentText(): Promise<string | undefined> {
		return this.diffEditor?.document.getText()
	}

	protected override async saveDocument(): Promise<boolean> {
		const editor = this.diffEditor
		if (!editor) {
			return false
		}
		return this.documentOpManager.saveDocument(editor)
	}

	protected async closeAllDiffViews(): Promise<void> {
		await this.tabManager.closeOwnedDiffViews()
	}

	protected override async resetDiffView(): Promise<void> {
		this.reviewManager.hideReview()
		this.decorationManager?.reset()
		this.decorationManager = undefined
		this.streamingUpdater = undefined
		this.diffEditor = undefined
		await Promise.all([this.closeAllDiffViews(), this.notebookManager.cleanup()])
	}

	protected override async switchToSpecializedEditor(): Promise<void> {
		const editor = this.diffEditor
		if (!this.isNotebookFile() || !editor || !this.absolutePath) {
			return
		}

		await this.notebookManager.switchToSpecializedEditor(this.absolutePath, editor)
	}

	override async showFile(absolutePath: string): Promise<void> {
		const uri = vscode.Uri.file(absolutePath)

		if (this.isNotebookFile()) {
			await this.notebookManager.showFileForNotebook(uri)
			return
		}

		await vscode.window.showTextDocument(uri, { preview: false })
	}

	override async applyAndSaveSilently(
		absolutePath: string,
		content: string,
	): Promise<{
		finalContent: string | undefined
		autoFormattingEdits: string | undefined
		userEdits: string | undefined
	}> {
		return this.documentOpManager.applyAndSaveSilently(absolutePath, content)
	}

	override async showReview(
		files: { absolutePath: string; displayPath: string; content: string; originalContent?: string }[],
	): Promise<void> {
		await this.reviewManager.showReview(files)
	}

	override async applyAndSaveBatchSilently(
		files: { path: string; content: string }[],
	): Promise<
		Map<string, { finalContent: string | undefined; autoFormattingEdits: string | undefined; userEdits: string | undefined }>
	> {
		return this.documentOpManager.applyAndSaveBatchSilently(files)
	}

	override async format(filePath: string): Promise<string> {
		return this.documentOpManager.format(filePath)
	}

	override async hideReview(): Promise<void> {
		await this.reset()
	}
}
