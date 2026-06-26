import * as vscode from "vscode"
import { DecorationController } from "./DecorationController"

export class DecorationControllerManager {
	private fadedOverlay?: DecorationController
	private activeLine?: DecorationController

	constructor(private editor: vscode.TextEditor) {}

	initialize(): void {
		this.fadedOverlay = new DecorationController("fadedOverlay", this.editor)
		this.activeLine = new DecorationController("activeLine", this.editor)
		this.fadedOverlay.addLines(0, this.editor.document.lineCount)
	}

	get fadedOverlayController(): DecorationController | undefined {
		return this.fadedOverlay
	}

	get activeLineController(): DecorationController | undefined {
		return this.activeLine
	}

	updateAfterReplace(currentLine: number): void {
		this.activeLine?.setActiveLine(currentLine)
		this.fadedOverlay?.updateOverlayAfterLine(currentLine, this.editor.document.lineCount)
	}

	clearAll(): void {
		this.fadedOverlay?.clear()
		this.activeLine?.clear()
	}

	reset(): void {
		this.fadedOverlay = undefined
		this.activeLine = undefined
	}
}
