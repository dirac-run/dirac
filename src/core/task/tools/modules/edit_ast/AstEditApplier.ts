import type { SourceFileChange, SourceMutationPlan } from "@services/source-ast/types"
import { DiagnosticSeverity, type FileDiagnostics } from "@shared/proto/index.dirac"
import { getErrorMessage } from "@/shared/errors"
import type { IToolEnvironment, SaveResult } from "../../interfaces/IToolEnvironment"

export type AstEditDiagnosticsStatus = "not_run" | "unavailable" | "clean" | "problems" | "failed"

export interface AstEditFileApplyResult {
	file: SourceFileChange
	status: "saved" | "save_failed"
	finalContent?: string
	saveResult?: SaveResult
	saveError?: string
	diagnosticsStatus: AstEditDiagnosticsStatus
	diagnostics?: FileDiagnostics
	diagnosticsError?: string
	errorCount: number
}

export interface AstEditApplyResult {
	files: AstEditFileApplyResult[]
	savedFileCount: number
	failedFileCount: number
	diagnosticsErrorCount: number
	diagnosticsFailureCount: number
	partialFailure: boolean
}

/** Applies an already-approved immutable mutation plan and observes post-save diagnostics. */
export class AstEditApplier {
	public async apply(
		env: IToolEnvironment,
		plan: SourceMutationPlan,
		userEdits?: Record<string, string>,
	): Promise<AstEditApplyResult> {
		const files: AstEditFileApplyResult[] = []

		for (const file of plan.files) {
			const approvedContent = userEdits?.[file.displayPath] ?? userEdits?.[file.absolutePath] ?? file.content
			let currentContent: string
			try {
				currentContent = await env.editor.readText(file.absolutePath)
			} catch (error) {
				files.push({
					file,
					status: "save_failed",
					saveError: `Unable to verify the current file before saving: ${this.errorMessage(error)}`,
					diagnosticsStatus: "not_run",
					errorCount: 0,
				})
				continue
			}
			if (currentContent !== file.originalContent) {
				files.push({
					file,
					status: "save_failed",
					saveError:
						"The file changed after the AST plan was created. Re-inspect and retry instead of overwriting newer changes.",
					diagnosticsStatus: "not_run",
					errorCount: 0,
				})
				continue
			}

			let saveResult: SaveResult
			try {
				saveResult = await env.editor.applyAndSaveSilently(file.absolutePath, approvedContent, "modify")
			} catch (error) {
				files.push({
					file,
					status: "save_failed",
					saveError: this.errorMessage(error),
					diagnosticsStatus: "not_run",
					errorCount: 0,
				})
				continue
			}

			const finalContent = saveResult.content ?? approvedContent
			if (!env.diagnostics) {
				files.push({
					file,
					status: "saved",
					finalContent,
					saveResult,
					diagnosticsStatus: "unavailable",
					errorCount: 0,
				})
				continue
			}
			try {
				await env.diagnostics.prepare([file.absolutePath])
				const diagnostics = await env.diagnostics.getRaw([file.absolutePath])
				const fileDiagnostics = diagnostics.find(
					(candidate) =>
						candidate.filePath === file.absolutePath ||
						candidate.filePath === file.displayPath ||
						file.absolutePath.endsWith(candidate.filePath),
				)
				const errorCount =
					fileDiagnostics?.diagnostics.filter(
						(diagnostic) => diagnostic.severity === DiagnosticSeverity.DIAGNOSTIC_ERROR,
					).length ?? 0
				files.push({
					file,
					status: "saved",
					finalContent,
					saveResult,
					diagnosticsStatus: fileDiagnostics?.diagnostics.length ? "problems" : "clean",
					diagnostics: fileDiagnostics,
					errorCount,
				})
			} catch (error) {
				files.push({
					file,
					status: "saved",
					finalContent,
					saveResult,
					diagnosticsStatus: "failed",
					diagnosticsError: this.errorMessage(error),
					errorCount: 0,
				})
			}
		}

		const savedFileCount = files.filter((file) => file.status === "saved").length
		const failedFileCount = files.length - savedFileCount
		return {
			files,
			savedFileCount,
			failedFileCount,
			diagnosticsErrorCount: files.reduce((count, file) => count + file.errorCount, 0),
			diagnosticsFailureCount: files.filter((file) => file.diagnosticsStatus === "failed").length,
			partialFailure: savedFileCount > 0 && failedFileCount > 0,
		}
	}

	private errorMessage(error: unknown): string {
		return getErrorMessage(error)
	}
}
