import { IDiracTool } from "../../interfaces/IDiracTool"
import { IToolEnvironment } from "../../interfaces/IToolEnvironment"
import { SurfaceType } from "../../interfaces/SurfaceType"
import { DiracToolSpec, DiracDefaultTool } from "../../../../../shared/tools"
import { CardStatus } from "../../../../../shared/ExtensionMessage"
import { DiracIcon } from "@/shared/icons"
import { WorkspacePathAdapter } from "../../../../workspace/WorkspacePathAdapter"
import * as fs from "fs/promises"
import * as path from "path"

export interface SearchFilesArgs {
	paths: string[]
	regex: string
	file_pattern?: string
	context_lines?: string | number
	include_anchors?: boolean
}

interface SearchPathInfo {
	absolutePath: string
	workspaceName?: string
	workspaceRoot?: string
}

interface SearchExecutionResult {
	absolutePath: string
	workspaceName?: string
	workspaceResults: string
	resultCount: number
	success: boolean
	error?: string
}

export const search_files_spec: DiracToolSpec = {
	id: DiracDefaultTool.SEARCH,
	name: "search_files",
	description:
		"Regex search across files in the specified paths (files or directories). Skips non-useful content (.git, node_modules, build artifacts, etc. and all files and directories starting with a dot). Prefer AST tools over this when reasonable.",
	parameters: [
		{
			name: "paths",
			required: true,
			type: "array",
			items: { type: "string" },
			instruction: "The paths of the files or directories to search in.",
			usage: '["src/core", "src/services"]',
		},
		{
			name: "regex",
			required: true,
			instruction: "The regular expression pattern to search for (Rust regex syntax).",
			usage: "Regex pattern here",
		},
		{
			name: "file_pattern",
			required: false,
			instruction: "Glob pattern to filter files (e.g., '*.ts').",
			usage: "*.ts",
		},
		{
			name: "context_lines",
			required: false,
			instruction: "Optional number of context lines to show before and after each match (0-10, default 0).",
			usage: "2",
		},
		{
			name: "include_anchors",
			required: false,
			type: "boolean",
			instruction:
				"Optional. When true, returns source lines prefixed with stable hash anchors usable by edit_file. Default false.",
			usage: "true",
		},
	],
}

export class SearchFilesTool implements IDiracTool<SearchFilesArgs, string> {
	spec(): DiracToolSpec {
		return search_files_spec
	}

	supportedSurfaces(): SurfaceType[] {
		return ["all"]
	}

	async processCall(args: SearchFilesArgs, env: IToolEnvironment): Promise<string> {
		const { paths, regex, file_pattern, context_lines } = args
		const includeAnchors = args.include_anchors === true
		if (!paths || paths.length === 0) {
			env.orchestration.setTaskState(
				"consecutiveMistakeCount",
				env.orchestration.getTaskState("consecutiveMistakeCount") + 1,
			)
			return `Error: Missing required parameter: paths`
		}
		if (!regex) {
			env.orchestration.setTaskState(
				"consecutiveMistakeCount",
				env.orchestration.getTaskState("consecutiveMistakeCount") + 1,
			)
			return `Error: Missing required parameter: regex`
		}
		const contextLines = typeof context_lines === "string" ? Number.parseInt(context_lines, 10) : context_lines
		const headerPath = paths.length === 1 ? paths[0] : `${paths[0]} (+${paths.length - 1} more)`
		const isSubagent = env.config.isSubagentExecution
		const card = !isSubagent
			? await env.ui.createCard({
					header: `Searching '${regex}' in ${headerPath}`,
					icon: DiracIcon.SEARCH,
					collapsed: true,
				})
			: undefined

		try {
			// 1. Resolve paths
			const { allSearchPaths, anyUsedWorkspaceHint } = await this.resolveSearchPaths(paths, env)

			// 2. Execute search
			const { searchResults, searchDurationMs } = await this.executeSearch(
				allSearchPaths,
				regex,
				file_pattern,
				contextLines,
				env,
				card,
				includeAnchors,
			)

			// 3. Surface total failures before formatting. Empty successful searches are
			// valid, but failed executions must never be presented as "0 results".
			const failedResults = searchResults.filter((result) => !result.success)
			const allFailed = failedResults.length === searchResults.length
			if (allFailed) {
				const failureMessage = this.formatSearchFailureMessage(failedResults)
				this.captureTelemetry(allSearchPaths, anyUsedWorkspaceHint, 0, searchDurationMs, env)
				this.updateMistakeCount(searchResults, env)
				if (card) {
					await card.update({
						header: `Search failed in ${headerPath}`,
						status: CardStatus.ERROR,
						body: failureMessage,
					})
					await card.finalize(CardStatus.ERROR)
				}
				return failureMessage
			}

			// 4. Format results
			const { finalResult, totalResultCount } = this.formatSearchResults(searchResults, allSearchPaths, env)

			// 5. Telemetry and Mistake Count
			this.captureTelemetry(allSearchPaths, anyUsedWorkspaceHint, totalResultCount, searchDurationMs, env)
			this.updateMistakeCount(searchResults, env)

			if (card) {
				const partialFailureSummary = failedResults.length > 0 ? `; ${failedResults.length} path(s) failed` : ""
				await card.update({
					header: `Searched '${regex}' in ${headerPath}`,
					status: CardStatus.SUCCESS,
					body: `Found ${totalResultCount} matches for '${regex}'${partialFailureSummary}`,
				})
				await card.finalize(CardStatus.SUCCESS)
			}

			return finalResult
		} catch (error) {
			const errorMessage = error instanceof Error ? error.message : String(error)
			if (card) {
				await card.update({
					status: CardStatus.ERROR,
					body: `Error: ${errorMessage}`,
				})
				await card.finalize(CardStatus.ERROR)
			}
			return `Error: ${errorMessage}`
		}
	}

	private async resolveSearchPaths(paths: string[], env: IToolEnvironment) {
		const allSearchPaths: Array<{ absolutePath: string; workspaceName?: string; workspaceRoot?: string }> = []
		let anyUsedWorkspaceHint = false

		for (const relPath of paths) {
			if (env.config.isMultiRootEnabled && env.config.workspaceManager) {
				const adapter = new WorkspacePathAdapter({
					cwd: env.config.cwd,
					isMultiRootEnabled: true,
					workspaceManager: env.config.workspaceManager,
				})

				const match = relPath.match(/^@(\w+):(.+)$/)
				if (match) {
					anyUsedWorkspaceHint = true
					const workspaceHint = match[1]
					const parsedPath = match[2]
					const absolutePath = adapter.resolvePath(parsedPath, workspaceHint)
					const workspaceRoots = adapter.getWorkspaceRoots()
					const root = workspaceRoots.find((r) => r.name === workspaceHint)
					allSearchPaths.push({ absolutePath, workspaceName: workspaceHint, workspaceRoot: root?.path })
				} else {
					const allPaths = adapter.getAllPossiblePaths(relPath)
					const workspaceRoots = adapter.getWorkspaceRoots()
					allPaths.forEach((absPath, index) => {
						allSearchPaths.push({
							absolutePath: absPath,
							workspaceName: workspaceRoots[index]?.name || path.basename(workspaceRoots[index]?.path || absPath),
							workspaceRoot: workspaceRoots[index]?.path,
						})
					})
				}
			} else {
				const { absolutePath } = await env.workspace.resolvePath(relPath)
				allSearchPaths.push({ absolutePath, workspaceRoot: env.config.cwd })
			}
		}

		// Capture workspace path resolution telemetry
		if (env.config.isMultiRootEnabled && env.config.workspaceManager) {
			const resolutionType = anyUsedWorkspaceHint
				? "hint_provided"
				: allSearchPaths.length > 1
					? "cross_workspace_search"
					: "fallback_to_primary"

			env.telemetry.captureCustomMetadata({
				workspaceResolutionType: resolutionType,
				workspaceResolutionSuccess: allSearchPaths.length > 0,
				usedWorkspaceHint: anyUsedWorkspaceHint,
			})
		}

		return { allSearchPaths, anyUsedWorkspaceHint }
	}

	private async executeSearch(
		allSearchPaths: SearchPathInfo[],
		regex: string,
		filePattern: string | undefined,
		contextLines: number | undefined,
		env: IToolEnvironment,
		card: any,
		includeAnchors: boolean,
	): Promise<{ searchResults: SearchExecutionResult[]; searchDurationMs: number }> {
		const searchStartTime = Date.now()
		const searchPromises = allSearchPaths.map(async ({ absolutePath, workspaceName }) => {
			if (card) {
				await card.appendBody(`🔍 Searching in ${workspaceName || absolutePath}...\n`)
			}
			// Check if directory exists before searching.
			// Non-existent paths are a valid user input, not a tool error.
			try {
				await fs.access(absolutePath)
			} catch {
				return {
					absolutePath,
					workspaceName,
					workspaceResults: "Found 0 results.",
					resultCount: 0,
					success: true,
				}
			}
			try {
				const results = await env.system.searchFiles(absolutePath, regex, {
					filePattern: filePattern,
					contextLines,
					excludeFilePatterns: ["!.*", "!**/.*"],
					includeAnchors,
				})

				const firstLine = results.split("\n")[0]

				// Parse the result count from the regexSearchFiles header. The header may be
				// either the complete-result format (`Found N results.`) or the truncated
				// format (`Showing first X of N+ results...`).
				const resultCount = this.parseSearchResultCount(results)

				if (card) {
					await card.appendBody(`✅ Found ${resultCount} results in ${workspaceName || absolutePath}.\n`)
				}
				return {
					absolutePath,
					workspaceName,
					workspaceResults: results,
					resultCount,
					success: true,
				}
			} catch (error) {
				const errorMessage = error instanceof Error ? error.message : String(error)
				if (card) {
					await card.appendBody(`❌ Search failed in ${workspaceName || absolutePath}: ${errorMessage}\n`)
				}
				return {
					absolutePath,
					workspaceName,
					workspaceResults: "",
					resultCount: 0,
					success: false,
					error: errorMessage,
				}
			}
		})

		const searchResults = await Promise.all(searchPromises)
		const searchDurationMs = Date.now() - searchStartTime
		return { searchResults, searchDurationMs }
	}

	private parseSearchResultCount(results: string): number {
		const firstLine = results
			.split("\n")
			.find((line) => line.trim().length > 0)
			?.trim()

		if (!firstLine) {
			return 0
		}

		const foundMatch = firstLine.match(/^Found\s+([\d,]+)\s+results?\.?$/i)
		if (foundMatch) {
			return Number.parseInt(foundMatch[1].replace(/,/g, ""), 10)
		}

		const truncatedMatch = firstLine.match(/^Showing first\s+[\d,]+\s+of\s+([\d,]+)\+?\s+results?/i)
		if (truncatedMatch) {
			return Number.parseInt(truncatedMatch[1].replace(/,/g, ""), 10)
		}

		return 0
	}

	private formatSearchResults(searchResults: SearchExecutionResult[], allSearchPaths: SearchPathInfo[], env: IToolEnvironment) {
		let finalResult = ""
		let totalResultCount = 0
		const allResults: string[] = []
		const failedResults = searchResults.filter((result) => !result.success)

		for (const { workspaceName, workspaceResults, resultCount, success } of searchResults) {
			if (!success || !workspaceResults) {
				continue
			}

			totalResultCount += resultCount

			if (env.config.isMultiRootEnabled && allSearchPaths.length > 1 && workspaceName) {
				if (resultCount > 0) {
					// Skip the "Found X results" line and add workspace annotation
					const lines = workspaceResults.split("\n")
					const resultsWithoutHeader = lines.length > 2 ? lines.slice(2).join("\n") : workspaceResults
					if (resultsWithoutHeader.trim()) {
						allResults.push(`## Workspace: ${workspaceName}\n${resultsWithoutHeader}`)
					}
				}
			} else if (!env.config.isMultiRootEnabled || allSearchPaths.length === 1) {
				allResults.push(workspaceResults)
			}
		}

		if (env.config.isMultiRootEnabled && allSearchPaths.length > 1) {
			if (totalResultCount === 0) {
				finalResult = "Found 0 results."
			} else {
				finalResult = `Found ${
					totalResultCount === 1 ? "1 result" : `${totalResultCount.toLocaleString()} results`
				} across ${allSearchPaths.length} workspace${allSearchPaths.length > 1 ? "s" : ""}.\n\n${allResults.join("\n\n")}`
			}
		} else {
			finalResult = allResults[0] || "Found 0 results."
		}

		if (failedResults.length > 0) {
			finalResult += `\n\n${this.formatSearchFailureMessage(failedResults)}`
		}

		return { finalResult, totalResultCount }
	}

	private formatSearchFailureMessage(failedResults: SearchExecutionResult[]): string {
		const details = failedResults
			.map((result) => {
				const label = result.workspaceName ? `${result.workspaceName} (${result.absolutePath})` : result.absolutePath
				return `- ${label}: ${result.error || "Unknown search error"}`
			})
			.join("\n")

		return `Search failed in ${failedResults.length} path${failedResults.length === 1 ? "" : "s"}:\n${details}`
	}

	private captureTelemetry(
		allSearchPaths: any[],
		anyUsedWorkspaceHint: boolean,
		totalResultCount: number,
		searchDurationMs: number,
		env: IToolEnvironment,
	) {
		if (env.config.isMultiRootEnabled && env.config.workspaceManager) {
			const searchType = anyUsedWorkspaceHint ? "targeted" : allSearchPaths.length > 1 ? "cross_workspace" : "primary_only"
			env.telemetry.captureCustomMetadata({
				searchType,
				searchPathCount: allSearchPaths.length,
				resultsFound: totalResultCount > 0,
				searchDurationMs,
			})
		}
	}

	private updateMistakeCount(searchResults: SearchExecutionResult[], env: IToolEnvironment) {
		// Only treat actual search execution failures as mistakes.
		// Empty results (no matches found) are valid outcomes, not mistakes.
		const allFailed = searchResults.every((r) => !r.success)
		if (allFailed) {
			env.orchestration.setTaskState(
				"consecutiveMistakeCount",
				env.orchestration.getTaskState("consecutiveMistakeCount") + 1,
			)
		} else {
			env.orchestration.setTaskState("consecutiveMistakeCount", 0)
		}
	}
}
