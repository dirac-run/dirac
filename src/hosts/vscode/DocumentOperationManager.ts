import pTimeout from "p-timeout"
import * as path from "path"
import * as vscode from "vscode"
import { Logger } from "@/shared/services/Logger"
import { createDirectoriesForFile } from "@/utils/fs"
import { arePathsEqual } from "@/utils/path"

export class DocumentOperationManager {
	async saveDocument(editor: vscode.TextEditor): Promise<boolean> {
		if (!editor) {
			return false
		}
		if (!editor.document.isDirty) {
			return true
		}
		try {
			await pTimeout(editor.document.save(), {
				milliseconds: 10_000,
				message: "Failed to save document in VS Code within 10 seconds",
			})
			return true
		} catch (error) {
			Logger.warn(`DocumentOperationManager: failed to save document: ${error}`)
			return false
		}
	}

	async applyAndSaveSilently(
		absolutePath: string,
		content: string,
	): Promise<{
		finalContent: string | undefined
		autoFormattingEdits: string | undefined
		userEdits: string | undefined
	}> {
		const uri = vscode.Uri.file(absolutePath)

		await createDirectoriesForFile(absolutePath)

		try {
			await vscode.workspace.fs.stat(uri)
		} catch (_error) {
			await vscode.workspace.fs.writeFile(uri, new Uint8Array())
		}

		const document = await vscode.workspace.openTextDocument(uri)

		const edit = new vscode.WorkspaceEdit()
		const range = new vscode.Range(0, 0, document.lineCount, 0)
		edit.replace(uri, range, content)
		await vscode.workspace.applyEdit(edit)

		await pTimeout(document.save(), {
			milliseconds: 10_000,
			message: "Failed to save document in VS Code within 10 seconds",
		})

		return this.computeResults(content, document)
	}

	async applyAndSaveBatchSilently(
		files: { path: string; content: string }[],
	): Promise<
		Map<string, { finalContent: string | undefined; autoFormattingEdits: string | undefined; userEdits: string | undefined }>
	> {
		const results = new Map<
			string,
			{ finalContent: string | undefined; autoFormattingEdits: string | undefined; userEdits: string | undefined }
		>()

		const edit = new vscode.WorkspaceEdit()
		const documents: vscode.TextDocument[] = []

		for (const file of files) {
			const uri = vscode.Uri.file(file.path)
			await createDirectoriesForFile(file.path)
			try {
				await vscode.workspace.fs.stat(uri)
			} catch (_error) {
				await vscode.workspace.fs.writeFile(uri, new Uint8Array())
			}

			const document = await vscode.workspace.openTextDocument(uri)
			documents.push(document)
			const range = new vscode.Range(0, 0, document.lineCount, 0)
			edit.replace(uri, range, file.content)
		}

		await vscode.workspace.applyEdit(edit)

		await Promise.all(
			documents.map((doc) =>
				pTimeout(doc.save(), {
					milliseconds: 10_000,
					message: `Failed to save document ${doc.uri.fsPath} in VS Code within 10 seconds`,
				}),
			),
		)

		const cwd = await (await import("@utils/path")).getCwd()
		const { formatResponse } = await import("@core/formatResponse")

		for (let i = 0; i < files.length; i++) {
			const file = files[i]
			const document = documents[i]
			const result = this.computeResults(file.content, document)
			const normalizedPostSaveContent = result.finalContent ?? ""

			let autoFormattingEdits: string | undefined
			if (result.finalContent && normalizedPostSaveContent !== result.finalContent) {
				autoFormattingEdits = formatResponse.createPrettyPatch(
					path.relative(cwd, file.path).replace(/\\/g, "/"),
					result.finalContent,
					normalizedPostSaveContent,
				)
			}

			results.set(file.path, {
				finalContent: normalizedPostSaveContent,
				autoFormattingEdits,
				userEdits: undefined,
			})
		}

		return results
	}

	private computeResults(content: string, document: vscode.TextDocument) {
		const postSaveContent = document.getText()
		const newContentEOL = content.includes("\r\n") ? "\r\n" : "\n"
		const normalizedNewContent = content.replace(/\r\n|\n/g, newContentEOL).trimEnd() + newContentEOL
		const normalizedPostSaveContent = postSaveContent.replace(/\r\n|\n/g, newContentEOL).trimEnd() + newContentEOL

		return {
			finalContent: normalizedPostSaveContent,
			autoFormattingEdits: undefined as string | undefined,
			userEdits: undefined as string | undefined,
		}
	}

	async format(filePath: string): Promise<string> {
		const uri = vscode.Uri.file(filePath)
		try {
			const document = await vscode.workspace.openTextDocument(uri)
			const editorConfig = vscode.workspace.getConfiguration("editor", uri)
			const insertSpaces = editorConfig.get<boolean>("insertSpaces", true)
			const tabSize = editorConfig.get<number>("tabSize", 4)
			const edits = await vscode.commands.executeCommand<vscode.TextEdit[]>("vscode.executeFormatDocumentProvider", uri, {
				insertSpaces,
				tabSize,
			})
			if (edits && edits.length > 0) {
				const edit = new vscode.WorkspaceEdit()
				edit.set(uri, edits)
				await vscode.workspace.applyEdit(edit)
				const editor = vscode.window.visibleTextEditors.find((e) => arePathsEqual(e.document.uri.fsPath, filePath))
				if (editor) {
					await editor.document.save()
				} else {
					await document.save()
				}
			}
			return document.getText()
		} catch (error) {
			Logger.warn(`DocumentOperationManager: format failed for ${filePath}: ${error}`)
			const document = await vscode.workspace.openTextDocument(uri)
			return document.getText()
		}
	}
}
