import deepEqual from "fast-deep-equal"
import * as path from "path"
import { Diagnostic, DiagnosticSeverity, FileDiagnostics } from "@/shared/proto/index.dirac"
import { Logger } from "@/shared/services/Logger"
import { formatLineWithHash } from "@/utils/line-hashing"
import { arePathsEqual, getCwd } from "@/utils/path"

export function getNewDiagnostics(oldDiagnostics: FileDiagnostics[], newDiagnostics: FileDiagnostics[]): FileDiagnostics[] {
	const oldMap = new Map<string, Diagnostic[]>()
	for (const diag of oldDiagnostics) {
		oldMap.set(diag.filePath, diag.diagnostics)
	}

	const newProblems: FileDiagnostics[] = []
	for (const newDiags of newDiagnostics) {
		const oldDiags = oldMap.get(newDiags.filePath) || []
		const newProblemsForFile = newDiags.diagnostics.filter(
			(newDiag) => !oldDiags.some((oldDiag) => deepEqual(oldDiag, newDiag)),
		)

		if (newProblemsForFile.length > 0) {
			newProblems.push({ filePath: newDiags.filePath, diagnostics: newProblemsForFile })
		}
	}

	return newProblems
}

// will return empty string if no problems with the given severity are found
export async function diagnosticsToProblemsString(
	diagnostics: FileDiagnostics[],
	severities?: DiagnosticSeverity[],
	fileContentMap?: Map<string, { lines: string[]; hashes?: string[] }>,
	maxErrors = 5,
): Promise<string> {
	const results = []
	let errorCount = 0

	for (const fileDiagnostics of diagnostics) {
		const problems = fileDiagnostics.diagnostics
			.filter((d) => !severities || severities.includes(d.severity))
			.slice(0, Math.max(0, maxErrors - errorCount))

		errorCount += problems.length

		const entry = Array.from(fileContentMap?.entries() || []).find(([p]) => arePathsEqual(p, fileDiagnostics.filePath))
		const content = entry ? entry[1] : undefined
		const problemString = await singleFileDiagnosticsToProblemsString(
			fileDiagnostics.filePath,
			problems,
			content?.lines,
			content?.hashes,
		)
		if (problemString) {
			results.push(problemString)
		}

		if (errorCount >= maxErrors) {
			break
		}
	}
	return results.join("\n\n")
}

export async function singleFileDiagnosticsToProblemsString(
	filePath: string,
	diagnostics: Diagnostic[],
	lines?: string[],
	hashes?: string[],
): Promise<string> {
	if (!diagnostics.length) {
		return ""
	}
	const cwd = await getCwd()
	const relPath = path.relative(cwd, filePath).toPosix()
	let result = `${relPath}`

	for (const diagnostic of diagnostics) {
		const label = severityToString(diagnostic.severity)
		// Lines are 0-indexed
		const line = diagnostic.range?.start ? `${diagnostic.range.start.line + 1}` : ""

		const source = diagnostic.source ? `${diagnostic.source} ` : ""
		result += `\n- [${source}${label}] Line ${line}: ${diagnostic.message}`

		if (lines && diagnostic.range?.start) {
			const lineIdx = diagnostic.range.start.line
			const start = Math.max(0, lineIdx - 3)
			const end = Math.min(lines.length - 1, lineIdx + 3)
			const context = lines
				.slice(start, end + 1)
				.map((l, i) => {
					const currentLineIdx = start + i
					const content = hashes ? formatLineWithHash(l, hashes[currentLineIdx]) : l
					if (currentLineIdx === lineIdx) {
						return `${content} <<<< [${source}${label}] Line ${line}: ${diagnostic.message}`
					}
					return content
				})
				.join("\n")
			result += `\n${context}`
		}
	}
	return result
}

function severityToString(severity: DiagnosticSeverity): string {
	switch (severity) {
		case DiagnosticSeverity.DIAGNOSTIC_ERROR:
			return "Error"
		case DiagnosticSeverity.DIAGNOSTIC_WARNING:
			return "Warning"
		case DiagnosticSeverity.DIAGNOSTIC_INFORMATION:
			return "Information"
		case DiagnosticSeverity.DIAGNOSTIC_HINT:
			return "Hint"
		default:
			Logger.warn("Unhandled diagnostic severity level:", severity)
			return "Diagnostic"
	}
}

export async function pollForNewDiagnostics(
	getDiagnostics: () => Promise<FileDiagnostics[]>,
	preDiagnostics: FileDiagnostics[],
	filePaths: string | string[],
	timeoutMs = 3500,
	pollingIntervalMs = 500,
	quietPeriodMs = 500,
): Promise<FileDiagnostics[]> {
	const startTime = Date.now()
	let attempts = 0
	const maxAttempts = 50 // Safety limit to prevent infinite loops in tests

	const paths = Array.isArray(filePaths) ? filePaths : [filePaths]

	while (Date.now() - startTime < timeoutMs && attempts < maxAttempts) {
		attempts++
		const currentDiagnostics = await getDiagnostics()

		let changed = false
		for (const filePath of paths) {
			const preFileDiags = preDiagnostics.find((p) => arePathsEqual(p.filePath, filePath))?.diagnostics || []
			const currentFileDiags = currentDiagnostics.find((p) => arePathsEqual(p.filePath, filePath))?.diagnostics || []

			if (!deepEqual(preFileDiags, currentFileDiags)) {
				changed = true
				break
			}
		}

		if (changed) {
			return currentDiagnostics
		}

		// If we've waited longer than the quiet period and no change was detected,
		// we can assume the diagnostics are stable (linter finished or didn't find anything new).
		if (Date.now() - startTime >= quietPeriodMs) {
			break
		}

		const remainingTime = timeoutMs - (Date.now() - startTime)
		if (remainingTime <= 0) break
		const waitTime = Math.max(pollingIntervalMs, 50)
		await new Promise((resolve) => setTimeout(resolve, Math.min(waitTime, remainingTime)))
	}

	// Final check if we timed out without detecting a change
	return await getDiagnostics()
}
