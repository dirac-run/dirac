import { IDiracTool } from "../../interfaces/IDiracTool"
import { IToolEnvironment } from "../../interfaces/IToolEnvironment"
import { SurfaceType } from "../../interfaces/SurfaceType"
import { DiracToolSpec, DiracDefaultTool } from "../../../../../shared/tools"
import { CardStatus } from "../../../../../shared/ExtensionMessage"
import { DiracIcon } from "@/shared/icons"
import { arePathsEqual } from "@/utils/path"
import { DiagnosticSeverity, FileDiagnostics } from "@/shared/proto/index.dirac"
import { DiagnosticFormatter } from "../../utils/DiagnosticFormatter"

export const diagnostics_scan_spec: DiracToolSpec = {
	id: DiracDefaultTool.DIAGNOSTICS_SCAN,
	name: "diagnostics_scan",
	description:
		"Runs diagnostics (linter and syntax checks) on the specified files and returns the results. This is useful for checking if recent changes introduced any errors or for getting a summary of existing problems in specific files.",
	parameters: [
		{
			name: "paths",
			required: true,
			type: "array",
			items: { type: "string" },
			instruction: "An array of relative paths to the files to scan.",
			usage: '["src/utils/math.ts", "src/utils/string.ts"]',
		},
	],
}

export interface DiagnosticsScanArgs {
	paths: string[]
}

export class DiagnosticsScanTool implements IDiracTool<DiagnosticsScanArgs, string> {
	private readonly baseDiagnosticsTimeoutMs = 2000
	private readonly diagnosticsDelayMs = 500

	spec(): DiracToolSpec {
		return diagnostics_scan_spec
	}

	supportedSurfaces(): SurfaceType[] {
		return ["all"]
	}

	async processCall(args: DiagnosticsScanArgs, env: IToolEnvironment): Promise<string> {
		const { paths: relPaths } = args

		if (!relPaths || relPaths.length === 0) {
			const currentMistakeCount = env.orchestration.getTaskState("consecutiveMistakeCount")
			env.orchestration.setTaskState("consecutiveMistakeCount", currentMistakeCount + 1)
			return "Error: Missing required parameter 'paths' or 'paths' is empty."
		}

		const isSubagent = env.config.isSubagentExecution
		const card = !isSubagent
			? await env.ui.createCard({
					header: `Scanning ${relPaths.length} file(s) for diagnostics`,
					icon: DiracIcon.DIAGNOSTICS,
					collapsed: true,
				})
			: undefined

		try {
			const fileInfos = await Promise.all(
				relPaths.map(async (relPath) => {
					const { absolutePath, displayPath } = await env.workspace.resolvePath(relPath)
					try {
						const content = await env.workspace.readFile(absolutePath)
						return { absolutePath, displayPath, content, error: undefined }
					} catch (error) {
						return {
							absolutePath,
							displayPath,
							content: "",
							error: error instanceof Error ? error.message : String(error),
						}
					}
				}),
			)

			const errorResults = fileInfos.filter((f) => f.error).map((f) => `- file: ${f.displayPath}\n  error: ${f.error}`)
			const validFiles = fileInfos.filter((f) => !f.error)

			if (validFiles.length === 0) {
				const result = errorResults.join("\n---\n")
				if (card) {
					await card.update({ status: CardStatus.ERROR, body: result })
					await card.finalize(CardStatus.ERROR)
				}
				return result
			}

			// Prepare diagnostics
			await env.diagnostics.prepare(validFiles.map((f) => f.absolutePath))

			// Polling logic
			const totalLines = validFiles.reduce((sum, f) => sum + f.content.split(/\r?\n/).length, 0)
			const timeoutMs = Math.min(this.baseDiagnosticsTimeoutMs + Math.floor(totalLines / 1000) * 1000, 10000)
			const startTime = Date.now()
			let allDiagnostics: FileDiagnostics[] = []
			let foundDiagnostics = false

			while (Date.now() - startTime < timeoutMs) {
				allDiagnostics = await env.diagnostics.getRaw(validFiles.map((f) => f.absolutePath))

				foundDiagnostics = validFiles.some((f) => {
					const fileDiags = allDiagnostics.find(
						(d) => arePathsEqual(d.filePath, f.displayPath) || arePathsEqual(d.filePath, f.absolutePath),
					)
					return (
						fileDiags?.diagnostics.some(
							(d) =>
								d.severity === DiagnosticSeverity.DIAGNOSTIC_ERROR ||
								d.severity === DiagnosticSeverity.DIAGNOSTIC_WARNING,
						) ?? false
					)
				})

				if (foundDiagnostics) {
					break
				}

				await new Promise((resolve) => setTimeout(resolve, this.diagnosticsDelayMs))
			}

			const results = validFiles.map((f) => {
				return DiagnosticFormatter.formatDetailed(f.displayPath, f.absolutePath, allDiagnostics, f.content)
			})

			const finalResult = [...errorResults, ...results].join("\n---\n")
			if (card) {
				await card.update({
					header: `Scanned ${relPaths.length} file(s) for diagnostics`,
					status: CardStatus.SUCCESS,
					body: finalResult,
				})
				await card.finalize(CardStatus.SUCCESS)
			}

			return finalResult
		} catch (error) {
			const errorMessage = error instanceof Error ? error.message : String(error)
			if (card) {
				await card.update({
					status: CardStatus.ERROR,
					body: `✕ Error: ${errorMessage}`,
				})
				await card.finalize(CardStatus.ERROR)
			}
			throw error
		}
	}
}
