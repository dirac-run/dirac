import * as vscode from "vscode"

function countTrailingNewlines(text: string): number {
	let count = 0
	for (let i = text.length - 1; i >= 0 && text[i] === "\n"; i -= 1) {
		count += 1
	}
	return count
}

export class StreamingTextUpdater {
	constructor(private editor: vscode.TextEditor) {}

	async replaceText(
		content: string,
		rangeToReplace: { startLine: number; endLine: number },
		currentLine: number | undefined,
	): Promise<void> {
		if (!this.editor.document) {
			throw new Error("User closed text editor, unable to edit file...")
		}

		const beginningOfDocument = new vscode.Position(0, 0)
		this.editor.selection = new vscode.Selection(beginningOfDocument, beginningOfDocument)

		const document = this.editor.document
		const replacingToEnd = rangeToReplace.endLine >= document.lineCount
		const edit = new vscode.WorkspaceEdit()
		const range = new vscode.Range(rangeToReplace.startLine, 0, rangeToReplace.endLine, 0)
		edit.replace(document.uri, range, content)
		await vscode.workspace.applyEdit(edit)

		if (replacingToEnd) {
			await this.fixTrailingNewlines(content, document)
		}

		if (currentLine !== undefined) {
			// Defer to caller for decoration updates
		}
	}

	private async fixTrailingNewlines(content: string, document: vscode.TextDocument): Promise<void> {
		const desiredTrailingNewlines = countTrailingNewlines(content)
		const actualTrailingNewlines = countTrailingNewlines(document.getText())
		const newlineDelta = desiredTrailingNewlines - actualTrailingNewlines

		if (newlineDelta > 0) {
			const fixEdit = new vscode.WorkspaceEdit()
			fixEdit.insert(document.uri, document.lineAt(document.lineCount - 1).range.end, "\n".repeat(newlineDelta))
			await vscode.workspace.applyEdit(fixEdit)
		} else if (newlineDelta < 0) {
			const fixEdit = new vscode.WorkspaceEdit()
			const startLine = Math.max(0, document.lineCount + newlineDelta)
			fixEdit.delete(document.uri, new vscode.Range(startLine, 0, document.lineCount, 0))
			await vscode.workspace.applyEdit(fixEdit)
		}
	}

	async scrollEditorToLine(line: number): Promise<void> {
		const scrollLine = line + 4
		this.editor.revealRange(new vscode.Range(scrollLine, 0, scrollLine, 0), vscode.TextEditorRevealType.InCenter)
	}

	async scrollAnimation(startLine: number, endLine: number): Promise<void> {
		const totalLines = endLine - startLine
		const numSteps = 10
		const stepSize = Math.max(1, Math.floor(totalLines / numSteps))

		for (let line = startLine; line <= endLine; line += stepSize) {
			this.editor.revealRange(new vscode.Range(line, 0, line, 0), vscode.TextEditorRevealType.InCenter)
			await new Promise((resolve) => setTimeout(resolve, 16))
		}
	}

	async truncateDocument(lineNumber: number): Promise<void> {
		const document = this.editor.document
		if (lineNumber < document.lineCount) {
			const edit = new vscode.WorkspaceEdit()
			edit.delete(document.uri, new vscode.Range(lineNumber, 0, document.lineCount, 0))
			await vscode.workspace.applyEdit(edit)
		}
	}

	get lineCount(): number {
		return this.editor.document.lineCount
	}
}
