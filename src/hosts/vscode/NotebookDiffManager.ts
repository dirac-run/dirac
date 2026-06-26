import * as vscode from "vscode"
import { Logger } from "@/shared/services/Logger"
import { NotebookDiffView } from "./NotebookDiffView"

export class NotebookDiffManager {
	private notebookDiffView?: NotebookDiffView

	isNotebookFile(relPath: string | undefined): boolean {
		return relPath?.toLowerCase().endsWith(".ipynb") ?? false
	}

	async switchToSpecializedEditor(absolutePath: string, editor: vscode.TextEditor): Promise<void> {
		if (!this.notebookDiffView) {
			try {
				this.notebookDiffView = new NotebookDiffView()
				await this.notebookDiffView.open(absolutePath, editor)
			} catch (error) {
				Logger.error("NotebookDiffManager: failed to create notebook diff view:", error)
			}
		}
	}

	async showFileForNotebook(uri: vscode.Uri): Promise<void> {
		const jupyterExtension = vscode.extensions.getExtension("ms-toolsai.jupyter")
		if (jupyterExtension) {
			await vscode.commands.executeCommand("vscode.openWith", uri, "jupyter-notebook")
			return
		}
		await vscode.window.showTextDocument(uri, { preview: false })
	}

	async cleanup(): Promise<void> {
		if (this.notebookDiffView) {
			await this.notebookDiffView.cleanup()
			this.notebookDiffView = undefined
		}
	}

	reset(): void {
		this.notebookDiffView = undefined
	}
}
