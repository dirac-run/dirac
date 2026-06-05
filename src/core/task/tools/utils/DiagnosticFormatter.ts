import { Diagnostic, DiagnosticSeverity, FileDiagnostics } from "@/shared/proto/index.dirac"
import { arePathsEqual } from "@/utils/path"

export class DiagnosticFormatter {
	/**
	 * Formats a list of diagnostics into a concise summary string.
	 */
	static formatSummary(diagnostics: Diagnostic[]): string {
		const errors = diagnostics.filter((d) => d.severity === DiagnosticSeverity.DIAGNOSTIC_ERROR)
		const warnings = diagnostics.filter((d) => d.severity === DiagnosticSeverity.DIAGNOSTIC_WARNING)

		const parts = []
		if (errors.length > 0) parts.push(`${errors.length} error(s)`)
		if (warnings.length > 0) parts.push(`${warnings.length} warning(s)`)

		return parts.length > 0 ? `Found ${parts.join(" and ")}.` : "No issues found."
	}

	/**
	 * Formats diagnostics with code context.
	 */
	static formatDetailed(
		displayPath: string,
		absolutePath: string,
		allDiagnostics: FileDiagnostics[],
		fileContent: string,
		options: { maxProblems?: number; contextLines?: number } = {},
	): string {
		const { maxProblems = 20, contextLines = 1 } = options

		const fileDiags = allDiagnostics.find(
			(d) => arePathsEqual(d.filePath, displayPath) || arePathsEqual(d.filePath, absolutePath),
		)

		const allProblems =
			fileDiags?.diagnostics.filter(
				(d) => d.severity === DiagnosticSeverity.DIAGNOSTIC_ERROR || d.severity === DiagnosticSeverity.DIAGNOSTIC_WARNING,
			) || []

		if (allProblems.length === 0) {
			return `- file: ${displayPath}\n  status: No diagnostics issues found.`
		}

		const problems = allProblems.slice(0, maxProblems)
		const truncatedCount = allProblems.length - problems.length

		const diagnosticsByLine = new Map<number, Diagnostic[]>()
		for (const d of problems) {
			const line = d.range?.start?.line ?? -1
			if (!diagnosticsByLine.has(line)) {
				diagnosticsByLine.set(line, [])
			}
			diagnosticsByLine.get(line)!.push(d)
		}

		const lines = fileContent.split(/\r?\n/)
		const formattedProblems = Array.from(diagnosticsByLine.entries())
			.sort(([lineA], [lineB]) => lineA - lineB)
			.map(([lineIdx, diags]) => {
				const lineNum = lineIdx + 1
				const contextStart = Math.max(0, lineIdx - contextLines)
				const contextEnd = Math.min(lines.length - 1, lineIdx + contextLines)

				return lines
					.slice(contextStart, contextEnd + 1)
					.map((l, i) => {
						const currentLineIdx = contextStart + i
						const isTargetLine = currentLineIdx === lineIdx
						if (isTargetLine) {
							const messages = diags
								.map((d) => {
									const label = d.severity === DiagnosticSeverity.DIAGNOSTIC_ERROR ? "Error" : "Warning"
									return `[${label}] Line ${lineNum}: ${d.message}`
								})
								.join("\n    ")
							return `    ${l} <<<< ${messages}`
						}
						return `    ${l}`
					})
					.join("\n")
			})
			.join("\n\n")

		const truncationNote = truncatedCount > 0 ? `\n\n    ... and ${truncatedCount} more errors.` : ""
		return `- file: ${displayPath}\n  diagnostics: |\n${formattedProblems}${truncationNote}`
	}
}
