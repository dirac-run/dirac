import pTimeout from "p-timeout"
import { HostProvider } from "@/hosts/host-provider"
import { DiagnosticSeverity, FileDiagnostics } from "@/shared/proto/index.dirac"
import { arePathsEqual } from "@/utils/path"
import { DiagnosticsFeedbackResult, IDiagnosticsProvider } from "./IDiagnosticsProvider"
import { diagnosticsToProblemsString, getNewDiagnostics, pollForNewDiagnostics } from "./index"

export class LinterFeedbackProvider implements IDiagnosticsProvider {
	constructor(
		private readonly diagnosticsTimeoutMs: number = 3_000,
		private readonly diagnosticsDelayMs: number = 500,
	) {}

	async capturePreSaveState(): Promise<FileDiagnostics[]> {
		return await this.getDiagnosticsSafe()
	}

	async getDiagnosticsFeedback(
		filePath: string,
		content: string,
		preSaveDiagnostics: FileDiagnostics[],
		hashes?: string[],
	): Promise<DiagnosticsFeedbackResult> {
		const postDiagnostics = await pollForNewDiagnostics(
			async () => await this.getDiagnosticsSafe([filePath]),
			preSaveDiagnostics,
			filePath,
			this.diagnosticsTimeoutMs,
			this.diagnosticsDelayMs,
			Math.min(this.diagnosticsTimeoutMs / 2, 500),
		)

		const newDiagnostics = getNewDiagnostics(preSaveDiagnostics, postDiagnostics)
		const postFileDiags = postDiagnostics.find((p) => arePathsEqual(p.filePath, filePath))?.diagnostics || []
		const preFileDiags = preSaveDiagnostics.find((p) => arePathsEqual(p.filePath, filePath))?.diagnostics || []

		const preErrors = preFileDiags.filter((d) => d.severity === DiagnosticSeverity.DIAGNOSTIC_ERROR)
		const postErrors = postFileDiags.filter((d) => d.severity === DiagnosticSeverity.DIAGNOSTIC_ERROR)

		let fixedCount = 0
		if (postErrors.length < preErrors.length) {
			fixedCount = preErrors.length - postErrors.length
		}

		const newProblemsMessage = await diagnosticsToProblemsString(
			newDiagnostics,
			[DiagnosticSeverity.DIAGNOSTIC_ERROR],
			new Map([[filePath, { lines: content.split(/\r?\n/), hashes }]]),
			5,
		)

		return {
			newProblemsMessage,
			fixedCount,
		}
	}

	async getDiagnosticsFeedbackForFiles(
		files: Array<{ filePath: string; content: string; hashes?: string[] }>,
		preSaveDiagnostics: FileDiagnostics[],
	): Promise<DiagnosticsFeedbackResult[]> {
		const postDiagnostics = await pollForNewDiagnostics(
			async () => await this.getDiagnosticsSafe(files.map((f) => f.filePath)),
			preSaveDiagnostics,
			files.map((f) => f.filePath),
			this.diagnosticsTimeoutMs,
			this.diagnosticsDelayMs,
			Math.min(this.diagnosticsTimeoutMs / 2, 500),
		)

		const newDiagnostics = getNewDiagnostics(preSaveDiagnostics, postDiagnostics)

		return Promise.all(
			files.map(async (f) => {
				const postFileDiags = postDiagnostics.find((p) => arePathsEqual(p.filePath, f.filePath))?.diagnostics || []
				const preFileDiags = preSaveDiagnostics.find((p) => arePathsEqual(p.filePath, f.filePath))?.diagnostics || []

				const preErrors = preFileDiags.filter((d) => d.severity === DiagnosticSeverity.DIAGNOSTIC_ERROR)
				const postErrors = postFileDiags.filter((d) => d.severity === DiagnosticSeverity.DIAGNOSTIC_ERROR)

				let fixedCount = 0
				if (postErrors.length < preErrors.length) {
					fixedCount = preErrors.length - postErrors.length
				}

				const newProblemsMessage = await diagnosticsToProblemsString(
					newDiagnostics.filter((d) => arePathsEqual(d.filePath, f.filePath)),
					[DiagnosticSeverity.DIAGNOSTIC_ERROR],
					new Map([[f.filePath, { lines: f.content.split(/\r?\n/), hashes: f.hashes }]]),
					5,
				)

				return {
					newProblemsMessage,
					fixedCount,
				}
			}),
		)
	}

	private async getDiagnosticsSafe(filePaths: string[] = []): Promise<FileDiagnostics[]> {
		try {
			const response = await pTimeout(HostProvider.workspace.getDiagnostics({ filePaths }), {
				milliseconds: this.diagnosticsTimeoutMs,
			})
			return response.fileDiagnostics
		} catch (error) {
			return []
		}
	}
}
