import { randomUUID } from "crypto"
import * as os from "os"
import * as path from "path"
import * as vscode from "vscode"
import { Logger } from "@/shared/services/Logger"

/**
 * Handles Jupyter notebook diff views with cell-level rendering.
 *
 * Creates a temporary file with modified content and opens VS Code's native
 * notebook diff view, which provides meaningful cell-level comparisons instead
 * of raw JSON diffs.
 */
export class NotebookDiffView {
	private tempModifiedUri?: vscode.Uri
	private tempFileWatcher?: vscode.FileSystemWatcher
	private stopping = false

	/**
	 * Opens a notebook diff view for the given file.
	 *
	 * @param absolutePath Path to the notebook file
	 * @param editor The active text editor containing modified content
	 */
	async open(absolutePath: string, editor: vscode.TextEditor): Promise<void> {
		const uri = vscode.Uri.file(absolutePath)
		const fileName = path.basename(uri.fsPath)

		// Check if Jupyter extension is available
		const jupyterExtension = vscode.extensions.getExtension("ms-toolsai.jupyter")
		if (!jupyterExtension) {
			vscode.window.showErrorMessage("Jupyter extension is required for notebook diffs.")
			return
		}

		if (!jupyterExtension.isActive) {
			await jupyterExtension.activate()
		}

		await this.createDiffView(uri, fileName, editor)
	}

	private async createDiffView(uri: vscode.Uri, fileName: string, editor: vscode.TextEditor): Promise<void> {
		const tempDir = os.tmpdir()
		const tempModifiedPath = path.join(tempDir, `dirac-modified-${randomUUID()}-${fileName}`)

		const currentContent = editor.document.getText()

		// Validate JSON before creating notebook diff
		try {
			JSON.parse(currentContent)
		} catch {
			Logger.error(`Invalid JSON content for notebook file ${fileName}, skipping notebook diff view`)
			return
		}

		await vscode.workspace.fs.writeFile(vscode.Uri.file(tempModifiedPath), new TextEncoder().encode(currentContent))

		this.tempModifiedUri = vscode.Uri.file(tempModifiedPath)
		this.setupFileWatcher(editor)

		await vscode.commands.executeCommand(
			"vscode.diff",
			uri,
			this.tempModifiedUri,
			`${fileName}: Original ↔ Dirac's Changes (Notebook)`,
		)

		// Brief delay to allow VS Code to render the notebook diff view
		await new Promise((resolve) => setTimeout(resolve, 500))
	}

	private setupFileWatcher(editor: vscode.TextEditor): void {
		if (!this.tempModifiedUri) {
			return
		}

		const tempDir = path.dirname(this.tempModifiedUri.fsPath)
		const tempFileName = path.basename(this.tempModifiedUri.fsPath)
		this.tempFileWatcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(tempDir, tempFileName))

		this.tempFileWatcher.onDidChange(() => {
			if (this.stopping) return
			void this.syncToEditor(editor)
		})
	}

	private async syncToEditor(editor: vscode.TextEditor): Promise<void> {
		if (!this.tempModifiedUri || !editor.document) {
			return
		}

		try {
			const tempContent = await vscode.workspace.fs.readFile(this.tempModifiedUri)
			if (this.stopping) return
			const tempContentString = new TextDecoder().decode(tempContent)

			const edit = new vscode.WorkspaceEdit()
			const fullRange = new vscode.Range(0, 0, editor.document.lineCount, 0)
			edit.replace(editor.document.uri, fullRange, tempContentString)
			await vscode.workspace.applyEdit(edit)
		} catch (error) {
			Logger.error("Failed to sync temp file to editor:", error)
		}
	}

	async cleanup(): Promise<void> {
		this.stopping = true
		if (this.tempFileWatcher) {
			this.tempFileWatcher.dispose()
			this.tempFileWatcher = undefined
		}

		if (this.tempModifiedUri) {
			const tempModifiedUri = this.tempModifiedUri
			this.tempModifiedUri = undefined
			const modifiedUri = tempModifiedUri.toString()
			const tabs = vscode.window.tabGroups.all
				.flatMap((group) => group.tabs)
				.filter(
					(tab) =>
						(tab.input instanceof vscode.TabInputNotebookDiff || tab.input instanceof vscode.TabInputTextDiff) &&
						tab.input.modified.toString() === modifiedUri,
				)
			// Release local state now; keep the backing file until the host confirms closure.
			void (async () => {
				try {
					const closed = await Promise.all(tabs.map((tab) => tab.isDirty ? false : vscode.window.tabGroups.close(tab)))
					if (!closed.every(Boolean)) return
					// Ordinary tabs belong to the user. Keep their backing file, including
					// views opened while a diff-close acknowledgement was pending.
					const stillReferenced = vscode.window.tabGroups.all.flatMap((group) => group.tabs).some((tab) => {
						const input = tab.input
						if (input instanceof vscode.TabInputText || input instanceof vscode.TabInputNotebook) {
							return input.uri.toString() === modifiedUri
						}
						return (input instanceof vscode.TabInputTextDiff || input instanceof vscode.TabInputNotebookDiff) &&
							(input.original.toString() === modifiedUri || input.modified.toString() === modifiedUri)
					})
					if (!stillReferenced) await vscode.workspace.fs.delete(tempModifiedUri)
				} catch (error) {
					Logger.error(`Failed to cleanup notebook diff: ${error}`)
				}
			})()
		}
	}
}
