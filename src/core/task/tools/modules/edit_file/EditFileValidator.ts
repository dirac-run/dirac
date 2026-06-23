import type { IToolEnvironment } from "../../interfaces/IToolEnvironment"
import { FileEdit } from "./types"

// Validates and normalizes edit_file parameters — JSON parsing, array checks, mistake counting.
export class EditFileValidator {
	// Parses/validates the files parameter; returns normalized files or an error string.
	validateFiles(args: { files: string | FileEdit[] }, env: IToolEnvironment): FileEdit[] | string {
		let { files } = args
		if (typeof files === "string") {
			try {
				files = JSON.parse(files)
			} catch (e) {
				this.incrementMistake(env)
				return `The 'files' parameter contains invalid JSON: ${e instanceof Error ? e.message : String(e)}`
			}
		}
		if (!Array.isArray(files)) {
			this.incrementMistake(env)
			return "The 'files' parameter must be a valid array of objects."
		}
		// Parse stringified edits inside each file
		for (const file of files) {
			if (typeof file.edits === "string") {
				try {
					file.edits = JSON.parse(file.edits)
				} catch {
					this.incrementMistake(env)
					return "The 'edits' parameter must be a valid JSON array of objects. If you provided a string, ensure it is valid JSON."
				}
			}
			if (!Array.isArray(file.edits)) {
				this.incrementMistake(env)
				return "The 'edits' parameter must be a valid JSON array of objects. If you provided a string, ensure it is valid JSON."
			}
		}
		return files
	}

	private incrementMistake(env: IToolEnvironment): void {
		env.orchestration.setTaskState("consecutiveMistakeCount", env.config.taskState.consecutiveMistakeCount + 1)
	}
}
