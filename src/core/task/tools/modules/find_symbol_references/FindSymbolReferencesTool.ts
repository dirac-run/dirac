import { formatResponse } from "@core/formatResponse"
import { AnchorStateManager } from "@utils/AnchorStateManager"
import { formatLineForModel } from "@utils/line-hashing"
import * as path from "path"
import { CardStatus } from "@/shared/ExtensionMessage"
import { DiracIcon } from "@/shared/icons"
import { DiracDefaultTool, DiracToolSpec } from "@/shared/tools"
import { IDiracTool } from "../../interfaces/IDiracTool"
import { ICardHandle, IToolEnvironment } from "../../interfaces/IToolEnvironment"
import { SurfaceType } from "../../interfaces/SurfaceType"

export interface FindSymbolReferencesArgs {
	symbols: string | string[]
	paths: string | string[]
	find_type?: "definition" | "reference" | "both"
	include_anchors?: boolean
}

interface ResolvedSearchPath {
	absolutePath: string
	displayPath: string
}

interface SymbolHit {
	symbol: string
	startLine: number
	[key: string]: any
}

interface SearchCard {
	symbol: string
	searchPath: ResolvedSearchPath
	card: ICardHandle
	hitsByFile: Map<string, SymbolHit[]>
	isFinalized: boolean
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
		const symbols = Array.isArray(args.symbols) ? args.symbols : args.symbols ? [args.symbols] : []
		const relPaths = Array.isArray(args.paths) ? args.paths : args.paths ? [args.paths] : []
		const findType = args.find_type || "both"
		const includeAnchors = args.include_anchors === true
		let cards: SearchCard[] | undefined

		if (symbols.length === 0 || relPaths.length === 0) {
			this.incrementMistakeCount(env)
			return formatResponse.missingToolParameterError(
				symbols.length === 0 ? "symbols" : "paths",
				symbols.length === 0 ? '["calculateTotal", "User"]' : '["src/core", "src/shared/utils.ts"]',
			)
		}

		try {
			await this.initializeIndex(env)

			const searchPaths = await this.resolveSearchPaths(relPaths, env)
			await this.updateIndexForPaths(
				searchPaths.map(({ absolutePath }) => absolutePath),
				env,
			)
			cards = env.config.isSubagentExecution ? undefined : await this.createSearchCards(symbols, searchPaths, findType, env)

			const fileHitsMap = await this.findSymbolLocations(symbols, searchPaths, findType, cards, env)
			await this.finalizeSearchCards(cards, findType, env, includeAnchors)

			if (fileHitsMap.size === 0) {
				return `No ${findType === "both" ? "references or definitions" : findType + "s"} found for symbols: ${symbols.join(", ")}.`
			}

			const output = await this.formatResults(fileHitsMap, env, includeAnchors)
			env.orchestration.setTaskState("consecutiveMistakeCount", 0)
			return output.trim()
		} catch (error: any) {
			await this.finalizeSearchCardsWithError(cards, error.message)
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

	private async resolveSearchPaths(relPaths: string[], env: IToolEnvironment): Promise<ResolvedSearchPath[]> {
		return await Promise.all(relPaths.map((relPath) => env.workspace.resolvePath(relPath)))
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

	private async createSearchCards(
		symbols: string[],
		searchPaths: ResolvedSearchPath[],
		findType: "definition" | "reference" | "both",
		env: IToolEnvironment,
	): Promise<SearchCard[]> {
		const cards: SearchCard[] = []
		const matchLabel = this.getMatchLabel(findType)

		for (const symbol of symbols) {
			for (const searchPath of searchPaths) {
				const card = await env.ui.createCard({
					header: `Finding ${matchLabel} for ${symbol} in ${searchPath.displayPath}`,
					icon: DiracIcon.SYMBOL_FIND,
					status: CardStatus.RUNNING,
					collapsed: true,
				})
				cards.push({
					symbol,
					searchPath,
					card,
					hitsByFile: new Map(),
					isFinalized: false,
				})
			}
		}

		return cards
	}

	private async findSymbolLocations(
		symbols: string[],
		searchPaths: ResolvedSearchPath[],
		findType: "definition" | "reference" | "both",
		cards: SearchCard[] | undefined,
		env: IToolEnvironment,
	): Promise<Map<string, SymbolHit[]>> {
		const fileHitsMap = new Map<string, SymbolHit[]>()

		for (const symbol of symbols) {
			let locations: any[] = []
			if (findType === "definition") {
				locations = await env.symbol.getDefinitions(symbol)
			} else if (findType === "reference") {
				locations = await env.symbol.getReferences(symbol)
			} else {
				locations = await env.symbol.getSymbols(symbol)
			}

			const symbolCards = cards?.filter((card) => card.symbol === symbol) || []
			for (const loc of locations) {
				const absLocPath = path.join(env.config.cwd, loc.path)
				if (!searchPaths.some((searchPath) => this.isWithinSearchPath(absLocPath, searchPath.absolutePath))) {
					continue
				}

				const hit = { ...loc, symbol }
				this.addHit(fileHitsMap, absLocPath, hit)
				for (const card of symbolCards) {
					if (this.isWithinSearchPath(absLocPath, card.searchPath.absolutePath)) {
						this.addHit(card.hitsByFile, absLocPath, hit)
					}
				}
			}
		}

		return fileHitsMap
	}

	private isWithinSearchPath(locationPath: string, searchPath: string): boolean {
		return locationPath === searchPath || locationPath.startsWith(searchPath + path.sep)
	}

	private addHit(fileHitsMap: Map<string, SymbolHit[]>, absFilePath: string, hit: SymbolHit): void {
		let hits = fileHitsMap.get(absFilePath)
		if (!hits) {
			hits = []
			fileHitsMap.set(absFilePath, hits)
		}
		hits.push(hit)
	}

	private async finalizeSearchCards(
		cards: SearchCard[] | undefined,
		findType: "definition" | "reference" | "both",
		env: IToolEnvironment,
		includeAnchors: boolean,
	): Promise<void> {
		if (!cards) return

		const fileContentCache = new Map<string, string>()
		const matchLabel = this.getMatchLabel(findType)
		for (const searchCard of cards) {
			const hitCount = Array.from(searchCard.hitsByFile.values()).reduce((total, hits) => total + hits.length, 0)
			const body =
				hitCount === 0
					? `No ${matchLabel} found.`
					: `✓ Found ${hitCount} ${matchLabel} across ${searchCard.hitsByFile.size} ${searchCard.hitsByFile.size === 1 ? "file" : "files"}\n\n${(
							await this.formatResults(searchCard.hitsByFile, env, includeAnchors, false, fileContentCache)
						).trim()}`

			await searchCard.card.update({
				header: `${hitCount === 0 ? "No" : "Found"} ${matchLabel} for ${searchCard.symbol} in ${searchCard.searchPath.displayPath}`,
				status: CardStatus.SUCCESS,
				body,
			})
			await searchCard.card.finalize(CardStatus.SUCCESS)
			searchCard.isFinalized = true
		}
	}

	private async finalizeSearchCardsWithError(cards: SearchCard[] | undefined, errorMessage: string): Promise<void> {
		if (!cards) return

		for (const searchCard of cards) {
			if (searchCard.isFinalized) continue
			await searchCard.card.update({
				status: CardStatus.ERROR,
				body: `✕ Error: ${errorMessage}`,
			})
			await searchCard.card.finalize(CardStatus.ERROR)
			searchCard.isFinalized = true
		}
	}

	private getMatchLabel(findType: "definition" | "reference" | "both"): string {
		if (findType === "both") return "references or definitions"
		return `${findType}s`
	}

	private async formatResults(
		fileHitsMap: Map<string, SymbolHit[]>,
		env: IToolEnvironment,
		includeAnchors: boolean,
		includeSymbols = true,
		fileContentCache = new Map<string, string>(),
	): Promise<string> {
		let output = ""
		const sortedFiles = Array.from(fileHitsMap.keys()).sort()

		for (const absFilePath of sortedFiles) {
			try {
				const fileHits = fileHitsMap.get(absFilePath)!
				let fileContent = fileContentCache.get(absFilePath)
				if (fileContent === undefined) {
					fileContent = await env.workspace.readFile(absFilePath)
					fileContentCache.set(absFilePath, fileContent)
				}
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
					const lineContent = lines[hit.startLine]
					const formattedLine = formatLineForModel(lineContent, anchors[hit.startLine], includeAnchors)
					const symbolPrefix = includeSymbols ? `(${Array.from(hit.symbols).join(", ")}) ` : ""
					fileRefs.push(`  ${symbolPrefix}${formattedLine}`)
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
