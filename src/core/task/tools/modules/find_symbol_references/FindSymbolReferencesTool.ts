import { IDiracTool } from "../../interfaces/IDiracTool"
import { IToolEnvironment } from "../../interfaces/IToolEnvironment"
import { DiracIcon } from "@/shared/icons"
import { DiracToolSpec, DiracDefaultTool } from "@/shared/tools"
import { SurfaceType } from "../../interfaces/SurfaceType"
import { AnchorStateManager } from "@utils/AnchorStateManager"
import { formatLineForModel } from "@utils/line-hashing"
import { CardStatus } from "@/shared/ExtensionMessage"
import * as path from "path"
import { formatResponse } from "@core/formatResponse"

export interface FindSymbolReferencesArgs {
	symbols: string | string[]
	paths: string | string[]
	find_type?: "definition" | "reference" | "both"
	include_anchors?: boolean
}

export const find_symbol_references_spec: DiracToolSpec = {
	id: DiracDefaultTool.FIND_SYMBOL_REFERENCES,
	name: "find_symbol_references",
	description:
		"Finds all exact AST references and invocations of one or more functions, classes, or variables across specified files or directories. Returns precise file paths.",
	parameters: [
		{
			name: "symbols",
			required: true,
			type: "array",
			items: { type: "string" },
			instruction: "An array of exact symbol names to find references for.",
			usage: '["calculateTotal", "User"]',
		},
		{
			name: "paths",
			required: true,
			type: "array",
			items: { type: "string" },
			instruction: "An array of relative paths to the directories or files to search.",
			usage: '["src/core", "src/shared/utils.ts"]',
		},
		{
			name: "find_type",
			required: false,
			type: "string",
			instruction:
				'Specifies the type of references to find. "definition" returns only definitions, "reference" returns only references, and "both" (default) returns both.',
			usage: '"reference"',
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

export class FindSymbolReferencesTool implements IDiracTool<FindSymbolReferencesArgs> {
	spec(): DiracToolSpec {
		return find_symbol_references_spec
	}

	supportedSurfaces(): SurfaceType[] {
		return ["all"]
	}

	async processCall(args: FindSymbolReferencesArgs, env: IToolEnvironment): Promise<string> {
		const isSubagent = env.config.isSubagentExecution
		const cards = !isSubagent ? new Map<string, any>() : undefined
		const symbols = Array.isArray(args.symbols) ? args.symbols : args.symbols ? [args.symbols] : []
		const relPaths = Array.isArray(args.paths) ? args.paths : args.paths ? [args.paths] : []
		const findType = args.find_type || "both"
		const includeAnchors = args.include_anchors === true

		if (symbols.length === 0 || relPaths.length === 0) {
			this.incrementMistakeCount(env)
			return formatResponse.missingToolParameterError(
				symbols.length === 0 ? "symbols" : "paths",
				symbols.length === 0 ? '["calculateTotal", "User"]' : '["src/core", "src/shared/utils.ts"]',
			)
		}

		try {
			await this.initializeIndex(env)

			const absolutePaths = await this.resolveAbsolutePaths(relPaths, env)
			await this.updateIndexForPaths(absolutePaths, env)

			const fileHitsMap = await this.findSymbolLocations(symbols, absolutePaths, findType, env, cards)

			if (fileHitsMap.size === 0) {
				// No results found is a valid outcome, not a mistake.
				return `No ${findType === "both" ? "references or definitions" : findType + "s"} found for symbols: ${symbols.join(", ")}.`
			}

			const output = await this.formatResults(fileHitsMap, env, includeAnchors)
			env.orchestration.setTaskState("consecutiveMistakeCount", 0)
			return output.trim()
		} catch (error: any) {
			this.incrementMistakeCount(env)
			return formatResponse.toolError(error.message)
		}
	}

	private incrementMistakeCount(env: IToolEnvironment): void {
		const currentMistakeCount = env.orchestration.getTaskState("consecutiveMistakeCount")
		env.orchestration.setTaskState("consecutiveMistakeCount", currentMistakeCount + 1)
	}

	private async initializeIndex(env: IToolEnvironment): Promise<void> {
		await env.symbol.initializeIndex(env.config.cwd)
	}

	private async resolveAbsolutePaths(relPaths: string[], env: IToolEnvironment): Promise<string[]> {
		const resolvedPaths = await Promise.all(relPaths.map((p) => env.workspace.resolvePath(p)))
		return resolvedPaths.map((rp) => rp.absolutePath)
	}

	private async updateIndexForPaths(absolutePaths: string[], env: IToolEnvironment): Promise<void> {
		if (absolutePaths.length <= 100) {
			for (const absPath of absolutePaths) {
				try {
					const info = await env.workspace.getFileInfo(absPath)
					if (info.isFile) {
						await env.symbol.updateIndex(absPath)
					}
				} catch (e) {
					// Skip if error
				}
			}
		}
	}

	private async findSymbolLocations(
		symbols: string[],
		absolutePaths: string[],
		findType: "definition" | "reference" | "both",
		env: IToolEnvironment,
		cards?: Map<string, any>,
	): Promise<Map<string, any[]>> {
		const fileHitsMap = new Map<string, any[]>()

		for (const symbol of symbols) {
			try {
				let locations: any[] = []
				if (findType === "definition") {
					locations = await env.symbol.getDefinitions(symbol)
				} else if (findType === "reference") {
					locations = await env.symbol.getReferences(symbol)
				} else {
					locations = await env.symbol.getSymbols(symbol)
				}

				for (const loc of locations) {
					const absLocPath = path.join(env.config.cwd, loc.path)
					const isInRequestedPath = absolutePaths.some(
						(requestedPath) => absLocPath === requestedPath || absLocPath.startsWith(requestedPath + path.sep),
					)

					if (isInRequestedPath) {
						let hits = fileHitsMap.get(absLocPath)
						if (!hits) {
							hits = []
							fileHitsMap.set(absLocPath, hits)
						}
						hits.push({ ...loc, symbol })

						if (cards && !cards.has(absLocPath)) {
							const { displayPath } = await env.workspace.resolvePath(absLocPath)
							const fileCard = await env.ui.createCard({
								header: `Finding references in ${displayPath}`,
								icon: DiracIcon.SYMBOL_FIND,
								collapsed: true,
							})
							cards.set(absLocPath, fileCard)
						}
					}
				}
			} catch (error: any) {
				if (cards) {
					for (const [absPath, c] of cards) {
						const hits = fileHitsMap.get(absPath) || []
						if (hits.length === 0) {
							await c.update({ status: CardStatus.ERROR, body: `✕ Error: ${error.message}` })
							await c.finalize(CardStatus.ERROR)
						}
					}
				}
				throw error
			}
		}

		if (cards) {
			for (const [absPath, card] of cards) {
				const hits = fileHitsMap.get(absPath) || []
				const foundSymbols = new Set(hits.map((h) => h.symbol))
				const firstSymbol = Array.from(foundSymbols)[0]
				const otherCount = foundSymbols.size - 1
				const { displayPath } = await env.workspace.resolvePath(absPath)

				const bodyLines = Array.from(foundSymbols).map((s) => {
					const symbolHits = hits.filter((h) => h.symbol === s).length
					return `✓ ${s} (${symbolHits} hits)`
				})

				await card.update({
					header: `Found references for ${firstSymbol}${otherCount > 0 ? ` (+${otherCount} more)` : ""} in ${displayPath}`,
					status: CardStatus.SUCCESS,
					body: bodyLines.join("\n"),
				})
				await card.finalize(CardStatus.SUCCESS)
			}
		}

		return fileHitsMap
	}

	private async formatResults(
		fileHitsMap: Map<string, any[]>,
		env: IToolEnvironment,
		includeAnchors: boolean,
	): Promise<string> {
		let output = ""
		const sortedFiles = Array.from(fileHitsMap.keys()).sort()

		for (const absFilePath of sortedFiles) {
			try {
				const fileHits = fileHitsMap.get(absFilePath)!
				const fileContent = await env.workspace.readFile(absFilePath)
				const lines = fileContent.split(/\r?\n/)
				const anchors = AnchorStateManager.reconcile(absFilePath, lines, env.config.ulid)

				const sortedHits = [...fileHits].sort((a, b) => a.startLine - b.startLine)
				const mergedHits: { startLine: number; symbols: Set<string> }[] = []

				for (const hit of sortedHits) {
					const last = mergedHits[mergedHits.length - 1]
					if (last && last.startLine === hit.startLine) {
						last.symbols.add(hit.symbol)
					} else {
						mergedHits.push({
							startLine: hit.startLine,
							symbols: new Set([hit.symbol]),
						})
					}
				}

				const fileRefs: string[] = []
				for (const hit of mergedHits) {
					const hitSymbols = Array.from(hit.symbols).join(", ")
					const lineContent = lines[hit.startLine]
					const formattedLine = formatLineForModel(lineContent, anchors[hit.startLine], includeAnchors)
					fileRefs.push(`  (${hitSymbols}) ${formattedLine}`)
				}

				const relPath = path.relative(env.config.cwd, absFilePath)
				output += `${relPath}:\n${fileRefs.join("\n")}\n\n`
			} catch (error: any) {
				output += `Error reading file ${absFilePath}: ${error.message}\n`
			}
		}

		return output
	}
}
