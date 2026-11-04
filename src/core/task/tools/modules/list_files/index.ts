import { formatResponse } from "@core/formatResponse"
import { getErrorMessage } from "@/shared/errors"
import { DiracIcon } from "@/shared/icons"
import { CardStatus } from "../../../../../shared/ExtensionMessage"
import { DiracDefaultTool, DiracToolSpec } from "../../../../../shared/tools"
import { IDiracTool } from "../../interfaces/IDiracTool"
import type { ICardHandle, IToolEnvironment } from "../../interfaces/IToolEnvironment"
import { SurfaceType } from "../../interfaces/SurfaceType"
import { ToolExecutionDeadline, ToolTimeoutError } from "../../runtime/ToolExecutionDeadline"
import { presentToolTimeout } from "../../runtime/ToolTimeoutPresentation"

export interface ListFilesArgs {
	paths: string[]
	recursive?: boolean
}

export const list_files_spec: DiracToolSpec = {
	id: DiracDefaultTool.LIST_FILES,
	name: "list_files",
	description:
		"List files and directories within the specified paths (one or more), or provide information about a specific file if a file path is provided. If recursive is true, it will list all files and directories recursively. Skips non-useful content (.git, node_modules, build artifacts, etc.). Files are sorted by most recently modified first within each directory. The output includes the line count for each file. Do not use this tool to confirm the existence of files you've just created.",
	parameters: [
		{
			name: "paths",
			required: true,
			type: "array",
			items: { type: "string" },
			instruction:
				"The paths of the directory to list contents for (relative to the current working directory {{CWD}}){{MULTI_ROOT_HINT}}",
		},
		{
			name: "recursive",
			required: false,
			instruction: "Whether to list files recursively. Use true for recursive listing, false or omit for top-level only.",
			type: "boolean",
		},
	],
}

export class ListFilesTool implements IDiracTool<ListFilesArgs, string> {
	private static readonly MAX_FILES_LIMIT = 200

	spec(): DiracToolSpec {
		return list_files_spec
	}

	supportedSurfaces(): SurfaceType[] {
		return ["all"]
	}

	async processCall(args: ListFilesArgs, env: IToolEnvironment): Promise<string> {
		const paths = Array.isArray(args.paths) ? args.paths : args.paths ? [args.paths] : []
		const recursive = String(args.recursive ?? "").toLowerCase() === "true"
		const deadline = new ToolExecutionDeadline(this.spec().name)

		if (paths.length === 0) {
			env.orchestration.setTaskState(
				"consecutiveMistakeCount",
				env.orchestration.getTaskState("consecutiveMistakeCount") + 1,
			)
			return formatResponse.toolError("Missing required parameter: paths")
		}

		// Resolve paths upfront and dedupe by absolute path to avoid
		// repeated listing of the same directory (e.g. [".", ".", "./"]).
		const resolvedPaths: { relPath: string; absolutePath: string; displayPath: string }[] = []
		const seenAbsPaths = new Set<string>()
		for (const relPath of paths) {
			let resolved: Awaited<ReturnType<IToolEnvironment["workspace"]["resolvePath"]>>
			try {
				resolved = await deadline.run(`resolving ${relPath}`, async () => await env.workspace.resolvePath(relPath))
			} catch (error) {
				if (error instanceof ToolTimeoutError) return await presentToolTimeout(env, error)
				throw error
			}
			const { absolutePath, displayPath } = resolved
			if (seenAbsPaths.has(absolutePath)) continue
			seenAbsPaths.add(absolutePath)
			resolvedPaths.push({ relPath, absolutePath, displayPath })
		}

		const card = new Map<string, { card: ICardHandle; displayPath: string }>()
		const results: string[] = []
		const displayPaths: string[] = []
		let hasError = false
		let totalFilesFound = 0
		let anyHitLimit = false
		let anyUsedWorkspaceHint = false
		let anyResolvedToNonPrimary = false

		for (const { relPath, absolutePath, displayPath } of resolvedPaths) {
			if (card) {
				const fileCard = await env.ui.createCard({
					header: `Listing files in ${displayPath}`,
					icon: DiracIcon.FILE_LIST,
					collapsed: true,
				})
				card.set(relPath, { card: fileCard, displayPath })
			}
			const accessAllowed = env.config.services.diracIgnoreController.validateAccess(relPath)
			if (!accessAllowed) {
				results.push(`Access to ${relPath} is blocked by .diracignore settings.`)
				hasError = true
				continue
			}

			try {
				const [fileInfos, didHitLimit] = await deadline.run(
					`listing ${displayPath}`,
					async () =>
						await env.workspace.listFiles(
							absolutePath,
							recursive,
							ListFilesTool.MAX_FILES_LIMIT,
						),
				)

				displayPaths.push(displayPath)
				anyHitLimit = anyHitLimit || didHitLimit
				const usedWorkspaceHint = displayPath !== relPath
				anyUsedWorkspaceHint = anyUsedWorkspaceHint || usedWorkspaceHint
				anyResolvedToNonPrimary = anyResolvedToNonPrimary || usedWorkspaceHint

				const formattedList = formatResponse.formatFilesList(
					absolutePath,
					fileInfos,
					didHitLimit,
					env.config.services.diracIgnoreController,
				)

				results.push(`Contents of ${relPath}:\n${formattedList}`)
				totalFilesFound += fileInfos.length
			} catch (error) {
				if (error instanceof ToolTimeoutError) {
					return await presentToolTimeout(env, error, card ? [...card.values()].map((entry) => entry.card) : [])
				}
				hasError = true
				const errorMessage = getErrorMessage(error)
				results.push(`Error listing files in ${relPath}: ${errorMessage}`)
				env.orchestration.setTaskState(
					"consecutiveMistakeCount",
					env.orchestration.getTaskState("consecutiveMistakeCount") + 1,
				)
			}
		}

		// Only reset on success. Do NOT increment on errors here —
		// path-not-found or diracignore denials are valid outcomes.
		// Missing-parameter mistakes are handled above.
		if (!hasError || totalFilesFound > 0) {
			env.orchestration.setTaskState("consecutiveMistakeCount", 0)
		}

		const finalResult = results.join("\n\n" + "=".repeat(20) + "\n\n")

		env.telemetry.captureCustomMetadata({
			isMultiRootEnabled: env.config.isMultiRootEnabled || false,
			usedWorkspaceHint: anyUsedWorkspaceHint,
			resolvedToNonPrimary: anyResolvedToNonPrimary,
			resolutionMethod: anyUsedWorkspaceHint ? "hint" : "primary_fallback",
			didHitLimit: anyHitLimit,
		})

		if (card) {
			for (const [relPath, { card: fileCard, displayPath }] of card) {
				const isError = results.find((r) => r.startsWith(`Error listing files in ${relPath}`))
				await fileCard.update({
					header: `Listed files in ${displayPath}`,
					status: isError ? CardStatus.ERROR : CardStatus.SUCCESS,
					body: isError ? `✕ ${isError}` : `✓ Listed directory contents`,
				})
				await fileCard.finalize(isError ? CardStatus.ERROR : CardStatus.SUCCESS)
			}
		}

		return finalResult
	}
}
