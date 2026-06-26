import { FileDiagnostics } from "@/shared/proto/index.dirac"

export interface DiagnosticsFeedbackResult {
	newProblemsMessage: string
	fixedCount: number
}

export interface IDiagnosticsProvider {
	/**
	 * Capture current diagnostics before a file operation to establish a baseline.
	 */
	capturePreSaveState(): Promise<FileDiagnostics[]>

	/**
	 * Generate feedback after a file operation, potentially comparing against pre-save state.
	 * @param filePath The absolute path of the file.
	 * @param content The current file content after the operation.
	 * @param preSaveDiagnostics Baseline diagnostics captured before the operation.
	 * @returns A result containing the problem summary and the count of fixed errors.
	 */
	getDiagnosticsFeedback(
		filePath: string,
		content: string,
		preSaveDiagnostics: FileDiagnostics[],
		hashes?: string[],
	): Promise<DiagnosticsFeedbackResult>

	/**
	 * Generate feedback for multiple files after an operation.
	 * @param files Array of file paths and their current contents.
	 * @param preSaveDiagnostics Baseline diagnostics captured before the operation.
	 */
	getDiagnosticsFeedbackForFiles(
		files: Array<{ filePath: string; content: string; hashes?: string[] }>,
		preSaveDiagnostics: FileDiagnostics[],
	): Promise<DiagnosticsFeedbackResult[]>
}
