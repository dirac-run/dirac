import { getErrorMessage } from "@/shared/errors"
import { DiracIcon } from "@/shared/icons"
import { DiagnosticSeverity, FileDiagnostics } from "@/shared/proto/index.dirac"
import { arePathsEqual } from "@/utils/path"
import { CardStatus } from "../../../../../shared/ExtensionMessage"
import { DiracDefaultTool, DiracToolSpec } from "../../../../../shared/tools"
import { IDiracTool } from "../../interfaces/IDiracTool"
import { IToolEnvironment } from "../../interfaces/IToolEnvironment"
import { SurfaceType } from "../../interfaces/SurfaceType"
import { ToolExecutionDeadline, ToolTimeoutError } from "../../runtime/ToolExecutionDeadline"
import { presentToolTimeout } from "../../runtime/ToolTimeoutPresentation"
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
		const cancellationSignal = env.orchestration.getTaskState("abortSignal")
		const deadline = new ToolExecutionDeadline(this.spec().name, { cancellationSignal })

		const isSubagent = env.config.isSubagentExecution
		const card = !isSubagent
			? await env.ui.createCard({
					header: `Scanning ${relPaths.length} file(s) for diagnostics`,
					icon: DiracIcon.DIAGNOSTICS,
					collapsed: true,
				})
			: undefined

		try {
			this.throwIfAborted(cancellationSignal)

			const fileInfos = await deadline.run("reading files for diagnostics", () =>
				Promise.all(relPaths.map((relPath) => this.readFileInfo(relPath, env.workspace))),
			)

			const errorResults = fileInfos.filter((f) => f.error).map((f) => `- file: ${f.displayPath}\n  error: ${f.error}`)
			const validFiles = fileInfos.filter((f) => !f.error)

			if (validFiles.length === 0) {
				const currentMistakeCount = env.orchestration.getTaskState("consecutiveMistakeCount")
				env.orchestration.setTaskState("consecutiveMistakeCount", currentMistakeCount + 1)
				const result = errorResults.join("\n---\n")
				if (card) {
					await card.update({ status: CardStatus.ERROR, body: result })
					await card.finalize(CardStatus.ERROR)
				}
				return result
			}

			// Prepare diagnostics
			await deadline.run("preparing diagnostics", () => env.diagnostics.prepare(validFiles.map((f) => f.absolutePath)))

			// Polling logic
			const totalLines = validFiles.reduce((sum, f) => sum + f.content.split(/\r?\n/).length, 0)
			const timeoutMs = Math.min(this.baseDiagnosticsTimeoutMs + Math.floor(totalLines / 1000) * 1000, 10000)
			const startTime = Date.now()
			let allDiagnostics: FileDiagnostics[] = []

			while (Date.now() - startTime < timeoutMs && !cancellationSignal?.aborted) {
				allDiagnostics = await deadline.run("collecting diagnostics", () =>
					env.diagnostics.getRaw(validFiles.map((f) => f.absolutePath)),
				)

				if (this.hasDiagnostics(validFiles, allDiagnostics)) {
					break
				}

				await this.interruptibleSleep(this.diagnosticsDelayMs, cancellationSignal)
			}

			this.throwIfAborted(cancellationSignal)

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
			if (cancellationSignal?.aborted) {
				if (card) {
					await card.update({
						header: "Cancelled scanning for diagnostics",
						status: CardStatus.CANCELLED,
						body: "Diagnostics scan cancelled.",
					})
					await card.finalize(CardStatus.CANCELLED)
				}
				throw error
			}
			if (error instanceof ToolTimeoutError) {
				return await presentToolTimeout(env, error, card ? [card] : [])
			}
			const errorMessage = getErrorMessage(error)
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

	private throwIfAborted(signal?: AbortSignal): void {
		if (signal?.aborted) {
			throw signal.reason || new Error("Tool execution cancelled")
		}
	}

	private async readFileInfo(relPath: string, workspace: IToolEnvironment["workspace"]) {
		const { absolutePath, displayPath } = await workspace.resolvePath(relPath)
		try {
			const content = await workspace.readFile(absolutePath)
			return { absolutePath, displayPath, content, error: undefined }
		} catch (error) {
			return {
				absolutePath,
				displayPath,
				content: "",
				error: getErrorMessage(error),
			}
		}
	}

	private hasDiagnostics(
		validFiles: Array<{ displayPath: string; absolutePath: string }>,
		allDiagnostics: FileDiagnostics[],
	): boolean {
		return validFiles.some((f) => {
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
	}

	private async interruptibleSleep(delayMs: number, signal?: AbortSignal): Promise<void> {
		this.throwIfAborted(signal)
		await new Promise<void>((resolve, reject) => {
			const onAbort = () => {
				clearTimeout(timer)
				reject(signal?.reason || new Error("Tool execution cancelled"))
			}
			const timer = setTimeout(() => {
				signal?.removeEventListener("abort", onAbort)
				resolve()
			}, delayMs)
			signal?.addEventListener("abort", onAbort, { once: true })
		})
	}
}
