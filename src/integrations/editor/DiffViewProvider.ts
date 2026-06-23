import { workspaceResolver } from "@core/workspace"
import { getCwd } from "@utils/path"
import { HostProvider } from "@/hosts/host-provider"
import { getDiagnosticsProviders } from "@/integrations/diagnostics/getDiagnosticsProviders"

import { FileDiagnostics } from "@/shared/proto/index.dirac"
import { Logger } from "@/shared/services/Logger"
import { sanitizeNotebookForLLM } from "../misc/notebook-utils"
import { openFile } from "../misc/open-file"
import { DiffContentManager } from "./DiffContentManager"
import { FileOperationManager } from "./FileOperationManager"

export abstract class DiffViewProvider {
	editType?: "create" | "modify" | "delete"
	isEditing = false
	protected documentWasOpen = false
	private preDiagnostics: FileDiagnostics[] = []
	protected relPath?: string
	protected absolutePath?: string
	protected fileEncoding = "utf8"
	protected newContent?: string

	protected fileOpManager?: FileOperationManager
	protected readonly contentManager: DiffContentManager

	constructor() {
		this.contentManager = new DiffContentManager()
	}

	public async open(relPath: string, options?: { displayPath?: string }): Promise<void> {
		this.isEditing = true
		const cwd = await getCwd()
		const absolutePathResolved = workspaceResolver.resolveWorkspacePath(cwd, relPath, "DiffViewProvider.open.absolutePath")
		this.absolutePath = typeof absolutePathResolved === "string" ? absolutePathResolved : absolutePathResolved.absolutePath
		this.relPath = options?.displayPath ?? relPath
		const fileExists = this.editType === "modify"

		if (fileExists) {
			await HostProvider.workspace.saveOpenDocumentIfDirty({
				filePath: this.absolutePath!,
			})
		}

		this.fileOpManager = new FileOperationManager(this.absolutePath, this.editType ?? "create")
		await this.fileOpManager.setup()
		this.originalContent = this.fileOpManager.originalContent
		this.fileEncoding = this.fileOpManager.fileEncoding

		const providers = getDiagnosticsProviders()
		this.preDiagnostics = (await Promise.all(providers.map((p) => p.capturePreSaveState()))).flat()
		await this.openDiffEditor()
		await this.scrollEditorToLine(0)
		this.contentManager.reset()
	}

	get originalContent(): string | undefined {
		return this.fileOpManager?.originalContent
	}

	set originalContent(value: string | undefined) {
		if (this.fileOpManager) {
			this.fileOpManager.originalContent = value
		}
	}

	protected abstract openDiffEditor(): Promise<void>
	protected abstract scrollEditorToLine(line: number): Promise<void>
	protected abstract scrollAnimation(startLine: number, endLine: number): Promise<void>
	protected abstract truncateDocument(lineNumber: number): Promise<void>
	protected abstract getDocumentLineCount(): Promise<number>

	private async safelyTruncateDocument(lineNumber: number): Promise<void> {
		const lineCount = await this.getDocumentLineCount()
		if (lineNumber < lineCount) {
			await this.truncateDocument(lineNumber)
		}
	}

	protected abstract getDocumentText(): Promise<string | undefined>

	private async getNewDiagnosticProblems(postSaveContent?: string): Promise<string> {
		if (!this.absolutePath) {
			return ""
		}
		const providers = getDiagnosticsProviders()
		let newProblemsMessage = ""

		for (const provider of providers) {
			const result = await provider.getDiagnosticsFeedback(this.absolutePath, postSaveContent || "", this.preDiagnostics)

			if (result.newProblemsMessage) {
				newProblemsMessage = result.newProblemsMessage
				break
			}
		}
		return newProblemsMessage
	}

	protected abstract saveDocument(): Promise<boolean>
	protected abstract closeAllDiffViews(): Promise<void>
	protected abstract resetDiffView(): Promise<void>

	protected async switchToSpecializedEditor(): Promise<void> {}

	async update(
		accumulatedContent: string,
		isFinal: boolean,
		changeLocation?: { startLine: number; endLine: number; startChar: number; endChar: number },
	) {
		if (!this.isEditing) {
			throw new Error("Not editing any file")
		}

		this.newContent = accumulatedContent
		const result = await this.contentManager.update(
			accumulatedContent,
			isFinal,
			async (content, range) => this.replaceText(content, range, undefined),
			async (line) => this.scrollEditorToLine(line),
			() => this.getDocumentLineCount(),
			async (start, end) => this.scrollAnimation(start, end),
		)

		if (isFinal) {
			await this.safelyTruncateDocument(result.lineCount)
			await this.onFinalUpdate()
			await this.switchToSpecializedEditor()
		}
	}

	protected async onFinalUpdate(): Promise<void> {}

	async showFile(absolutePath: string): Promise<void> {
		await openFile(absolutePath, true)
	}

	abstract replaceText(
		content: string,
		rangeToReplace: { startLine: number; endLine: number },
		currentLine: number | undefined,
	): Promise<void>

	protected isNotebookFile(): boolean {
		return this.relPath?.toLowerCase().endsWith(".ipynb") ?? false
	}

	getOriginalContentForLLM(): string | undefined {
		if (this.fileOpManager?.originalContent === undefined) return undefined
		return this.isNotebookFile()
			? sanitizeNotebookForLLM(this.fileOpManager.originalContent, true)
			: this.fileOpManager.originalContent
	}

	async saveChanges(options?: { skipDiagnostics?: boolean }): Promise<{
		newProblemsMessage: string | undefined
		userEdits: string | undefined
		autoFormattingEdits: string | undefined
		finalContent: string | undefined
	}> {
		const preSaveContent = await this.getDocumentText()

		if (!(await this.saveDocument())) {
			throw new Error(
				`Failed to save changes to ${this.relPath}. The file may be read-only or the save operation was cancelled.`,
			)
		}

		if (!this.relPath || !this.absolutePath || !this.newContent || preSaveContent === undefined) {
			return {
				newProblemsMessage: undefined,
				userEdits: undefined,
				autoFormattingEdits: undefined,
				finalContent: undefined,
			}
		}

		const postSaveContent = (await this.getDocumentText()) || ""

		await this.showFile(this.absolutePath)
		await this.closeAllDiffViews()

		let userEdits: string | undefined
		if (this.newContent !== undefined && preSaveContent !== undefined) {
			userEdits = this.contentManager.detectUserEdits(this.newContent, preSaveContent, this.relPath)
		}

		let autoFormattingEdits: string | undefined
		if (preSaveContent !== undefined && postSaveContent !== undefined) {
			autoFormattingEdits = this.contentManager.detectAutoFormattingEdits(preSaveContent, postSaveContent, this.relPath)
		}

		const newProblems = options?.skipDiagnostics ? "" : await this.getNewDiagnosticProblems(postSaveContent)
		const finalContent = this.contentManager.getFinalContent(postSaveContent, this.isNotebookFile())

		const newProblemsMessage =
			newProblems.length > 0 ? `\n\nNew problems detected after saving the file:\n${newProblems}` : ""
		return {
			newProblemsMessage,
			userEdits,
			autoFormattingEdits,
			finalContent,
		}
	}

	async revertChanges(): Promise<void> {
		if (!this.absolutePath || !this.isEditing) {
			return
		}

		const fileExists = this.editType === "modify"

		try {
			if (!fileExists) {
				await this.saveDocument()
				await this.closeAllDiffViews()
				await this.fileOpManager!.deleteFile()
				Logger.log(`File ${this.absolutePath} has been deleted.`)

				await this.fileOpManager!.deleteCreatedDirs()
			} else {
				const currentContents = await this.getDocumentText()
				if (currentContents !== undefined && this.originalContent !== undefined) {
					const lineCount = (currentContents.match(/\n/g) || []).length + 1
					await this.replaceText(this.originalContent, { startLine: 0, endLine: lineCount }, undefined)
					await this.saveDocument()
					Logger.log(`File ${this.absolutePath} has been reverted to its original content.`)
				} else {
					Logger.log(`Skipping content revert for ${this.absolutePath} as it was not successfully initialized.`)
				}

				if (this.documentWasOpen) {
					openFile(this.absolutePath, true)
				}
				await this.closeAllDiffViews()
			}
		} catch (error) {
			Logger.error(`Failed to revert changes for ${this.absolutePath}:`, error)
		} finally {
			await this.reset()
		}
	}

	async scrollToFirstDiff() {
		if (!this.isEditing) {
			return
		}
		await this.contentManager.scrollToFirstDiff(
			this.originalContent || "",
			async () => (await this.getDocumentText()) ?? "",
			(line) => this.scrollEditorToLine(line),
		)
	}

	async deleteFile(fileName: string) {
		const fileLocation = this.absolutePath
		if (!fileLocation?.endsWith(fileName) || !this.isEditing) {
			return
		}

		await this.closeAllDiffViews()

		try {
			await this.fileOpManager!.deleteFile()
			Logger.log(`File ${fileLocation} has been deleted.`)
		} catch (error) {
			Logger.error(`Failed to delete file ${fileLocation}:`, error)
		}

		this.isEditing = false
		this.newContent = undefined
	}

	async reset() {
		this.isEditing = false
		this.editType = undefined
		this.absolutePath = undefined
		this.relPath = undefined
		this.preDiagnostics = []
		this.fileEncoding = "utf8"
		this.documentWasOpen = false
		this.newContent = undefined

		this.contentManager.reset()
		await this.resetDiffView()
	}

	abstract applyAndSaveSilently(
		absolutePath: string,
		content: string,
	): Promise<{
		finalContent: string | undefined
		autoFormattingEdits: string | undefined
		userEdits: string | undefined
	}>

	abstract applyAndSaveBatchSilently(files: { path: string; content: string }[]): Promise<
		Map<
			string,
			{
				finalContent: string | undefined
				autoFormattingEdits: string | undefined
				userEdits: string | undefined
			}
		>
	>

	async showReview(
		_files: { absolutePath: string; displayPath: string; content: string; originalContent?: string }[],
	): Promise<void> {}
	async undoUserEdits() {
		if (this.newContent !== undefined) {
			await this.update(this.newContent, true)
		}
	}

	async hideReview(): Promise<void> {}
	abstract format(path: string): Promise<string>
}
