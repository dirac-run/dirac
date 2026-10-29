import type { SourceAstFailure, SourceMutationPlan } from "@services/source-ast/types"
import type { CardDiff } from "@shared/ExtensionMessage"
import { getErrorMessage } from "@/shared/errors"
import { DiagnosticFormatter } from "../../utils/DiagnosticFormatter"
import type { AstEditApplyResult, AstEditFileApplyResult } from "./AstEditApplier"
import type { EditAstArgs } from "./EditAstValidator"

const FAILURE_LABELS: Record<SourceAstFailure["status"], string> = {
	not_found: "Symbol not found",
	unsupported: "Unsupported file",
	inaccessible: "Access denied",
	parse_error: "Parse error",
	ambiguous: "Ambiguous symbol",
	no_change: "No changes required",
}

/** Owns all model-facing and compact card formatting for edit_ast. */
export class AstEditFormatter {
	public progressHeader(operation: EditAstArgs["operation"], file: SourceMutationPlan["files"][number]): string {
		const verb = operation === "rename" ? "Renaming" : "Replacing"
		return `${verb} ${this.symbolSummary(file.changedSymbols)} in ${file.displayPath}`
	}

	public completedHeader(operation: EditAstArgs["operation"], file: SourceMutationPlan["files"][number]): string {
		const verb = operation === "rename" ? "Renamed" : "Replaced"
		return `${verb} ${this.symbolSummary(file.changedSymbols)} in ${file.displayPath}`
	}

	public diffs(plan: SourceMutationPlan): CardDiff[] {
		return plan.files.map((file) => ({
			path: file.displayPath,
			oldText: file.originalContent,
			newText: file.content,
		}))
	}

	public approvalHeader(args: EditAstArgs, plan: SourceMutationPlan): string {
		const verb = args.operation === "rename" ? "Rename" : "Replace"
		return `${verb} ${plan.editCount} AST occurrence(s) in ${plan.files.length} file(s)?`
	}

	public approvalBody(args: EditAstArgs, plan: SourceMutationPlan): string {
		if (args.operation === "rename") {
			return `Rename \`${args.targets[0].symbol}\` to \`${args.targets[0].replacement}\` across ${plan.files.length} file(s).`
		}
		return plan.files
			.map((file) => `- ${file.changedSymbols.map((symbol) => `\`${symbol}\``).join(", ")} in ${file.displayPath}`)
			.join("\n")
	}

	public invalidPlan(plan: SourceMutationPlan): string {
		const sections: string[] = []
		if (plan.failures.length > 0) sections.push(this.formatFailures(plan.failures))
		if (plan.unchangedTargets.length > 0) {
			sections.push(
				["No changes required", ...plan.unchangedTargets.map((target) => `- ${target.symbol} in ${target.path}: ${target.reason}`)].join(
					"\n",
				),
			)
		}
		if (sections.length === 0) sections.push("No changes required")
		return sections.join("\n\n")
	}

	public formatResult(args: EditAstArgs, plan: SourceMutationPlan, applied: AstEditApplyResult): string {
		const sections: string[] = []
		const allSaved = applied.failedFileCount === 0
		sections.push(
			allSaved
				? `${args.operation === "rename" ? "Rename" : "Replacement"} completed: ${plan.editCount} edit(s) in ${applied.savedFileCount} file(s).`
				: applied.partialFailure
					? `Partial failure: saved ${applied.savedFileCount} of ${plan.files.length} file(s).`
					: `${args.operation === "rename" ? "Rename" : "Replacement"} failed: no files were saved.`,
		)
		sections.push(...applied.files.map((file) => this.formatFileResult(file)))
		if (plan.failures.length > 0) sections.push(`Partial failure\n${this.formatFailures(plan.failures)}`)
		if (plan.unchangedTargets.length > 0) {
			sections.push(
				["No changes required", ...plan.unchangedTargets.map((target) => `- ${target.symbol} in ${target.path}: ${target.reason}`)].join(
					"\n",
				),
			)
		}
		return sections.join("\n\n")
	}

	public formatFailure(error: unknown): string {
		return `AST edit failed: ${getErrorMessage(error)}`
	}

	private formatFileResult(result: AstEditFileApplyResult): string {
		if (result.status === "save_failed") {
			return `Save failed — ${result.file.displayPath}: ${result.saveError}`
		}

		const annotations: string[] = []
		if (result.saveResult?.userEdits) annotations.push("user made additional edits")
		if (result.saveResult?.autoFormatting) annotations.push("auto-formatting applied")
		let text = `Saved ${result.file.displayPath} (${result.file.editCount} edit(s))${
			annotations.length ? ` — ${annotations.join(", ")}` : ""
		}.`
		if (result.diagnosticsStatus === "unavailable") text += " Diagnostics not available on this host."
		if (result.diagnosticsStatus === "clean") text += " No diagnostics problems reported."
		if (result.diagnosticsStatus === "failed") {
			text += ` Diagnostics collection failed: ${result.diagnosticsError}`
		}
		if (result.diagnosticsStatus === "problems") {
			text += ` Diagnostics reported ${result.diagnostics?.diagnostics.length ?? 0} problem(s), including ${result.errorCount} error(s).`
			if (result.diagnostics && result.finalContent) {
				text += `\n${DiagnosticFormatter.formatDetailed(
					result.file.displayPath,
					result.file.absolutePath,
					[result.diagnostics],
					result.finalContent,
				)}`
			}
		}
		return text
	}

	private formatFailures(failures: SourceAstFailure[]): string {
		return failures
			.map((failure) => {
				const candidates = failure.candidates?.length
					? ` Candidates: ${failure.candidates
						.map((candidate) => `${candidate.qualifiedName} (${candidate.kind}, line ${candidate.declarationLine + 1})`)
						.join(", ")}.`
					: ""
				return `${FAILURE_LABELS[failure.status]} — ${failure.symbol ? `${failure.symbol} in ` : ""}${failure.path}: ${failure.message}${candidates}`
			})
			.join("\n")
	}

	private symbolSummary(symbols: string[]): string {
		if (symbols.length === 0) return "AST symbols"
		if (symbols.length === 1) return `'${symbols[0]}'`
		return `'${symbols[0]}' (+${symbols.length - 1} more)`
	}
}
