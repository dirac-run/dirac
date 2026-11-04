import { formatResponse } from "@core/formatResponse"
import { TOOL_EXAMPLES } from "@core/tool-examples"
import { getDelimiter } from "@utils/line-hashing"
import { isDeepStrictEqual } from "node:util"
import type {
	AstImplementationResult,
	AstOccurrenceResult,
	AstOutlineResult,
} from "@services/source-ast/types"
import { CardStatus } from "@shared/ExtensionMessage"
import { DiracIcon } from "@shared/icons"
import { DiracDefaultTool, type DiracToolSpec } from "@shared/tools"
import { getErrorMessage } from "@/shared/errors"
import type { IDiracTool } from "../../interfaces/IDiracTool"
import type { ICardHandle, IToolEnvironment } from "../../interfaces/IToolEnvironment"
import type { SurfaceType } from "../../interfaces/SurfaceType"
import { ToolExecutionDeadline, ToolTimeoutError } from "../../runtime/ToolExecutionDeadline"
import { presentToolTimeout } from "../../runtime/ToolTimeoutPresentation"
import {
	type FormattedInspectAstResult,
	type ImplementationCacheRecord,
	implementationCacheKey,
	InspectAstFormatter,
} from "./InspectAstFormatter"
import {
	type InspectAstImplementationGroup,
	type InspectAstOccurrenceGroup,
	type InspectAstOutlineGroup,
	type InspectAstResultGroup,
	InspectAstResultReducer,
} from "./InspectAstResultReducer"
import {
	type InspectAstArgs,
	type InspectAstOperation,
	InspectAstValidator,
	type NormalizedInspectAstArgs,
} from "./InspectAstValidator"

const IMPLEMENTATION_CACHE_KEY = "inspectAstImplementationCache"
const MAX_HEADER_PATH_LENGTH = 60

export const inspect_ast_spec: DiracToolSpec = {
	id: DiracDefaultTool.INSPECT_AST,
	name: "inspect_ast",
	description:
		"Read-only AST inspection for source outlines, complete named definitions, and exact indexed symbol locations. Prefer inspect_ast over broad read_file or text search when source structure or symbol identity matters. It never modifies files. Supports batched paths and symbols, including qualified names such as UserService.load.",
	parameters: [
		{
			name: "operation",
			required: true,
			type: "string",
			enum: ["outline", "implementation", "definitions", "references", "occurrences"],
			instruction:
				"Choose by input and result: outline takes source-file paths (no symbols) and returns structural declarations without implementation bodies; implementation takes source-file paths plus symbols and returns complete named definitions; definitions, references, and occurrences take file or directory scopes plus symbols and return exact indexed definition locations, reference locations, or both, respectively.",
		},
		{
			name: "paths",
			required: true,
			type: "array",
			items: { type: "string" },
			instruction: "Source files for outline or implementation; file or directory scopes for symbol lookups.",
		},
		{
			name: "symbols",
			required: false,
			type: "array",
			items: { type: "string" },
			instruction:
				"Required except for outline. Use exact qualified or unqualified names; qualify ambiguous symbols, for example UserService.load.",
		},
		{
			name: "include_anchors",
			required: false,
			type: "boolean",
			instruction: `When true, exact source lines are emitted as standalone complete ANCHOR${getDelimiter()}CONTENT coordinates required by edit_file. Outline provides declaration-line coordinates; implementation provides complete definition lines; symbol-location operations provide the containing source line. Default false.`,
		},
	],
}

interface InspectCardRecord {
	group: InspectAstResultGroup
	card: ICardHandle
	finalized: boolean
}

type InspectionExecution = (
	| {
		operation: "outline"
		result: AstOutlineResult
		groups: InspectAstOutlineGroup[]
		formatted: FormattedInspectAstResult
	}
	| {
		operation: "implementation"
		result: AstImplementationResult
		groups: InspectAstImplementationGroup[]
		formatted: FormattedInspectAstResult
	}
	| {
		operation: "definitions" | "references" | "occurrences"
		result: AstOccurrenceResult
		groups: InspectAstOccurrenceGroup[]
		formatted: FormattedInspectAstResult
	}
) & { warnings?: string[] }

/** Orchestrates read-only AST execution, logical result reduction, cards, formatting, and telemetry. */
export class InspectAstTool implements IDiracTool<InspectAstArgs, string> {
	private readonly formatter = new InspectAstFormatter()
	private readonly reducer = new InspectAstResultReducer()

	public spec(): DiracToolSpec {
		return inspect_ast_spec
	}

	public supportedSurfaces(): SurfaceType[] {
		return ["all"]
	}

	public async processCall(rawArgs: InspectAstArgs, env: IToolEnvironment): Promise<string> {
		const validation = InspectAstValidator.normalize(rawArgs)
		if (!validation.valid) {
			this.incrementMistakeCount(env)
			await env.ui.upsertText(`Dirac tried to use inspect_ast with invalid arguments. ${validation.message}`).catch(() => undefined)
			const example = TOOL_EXAMPLES[DiracDefaultTool.INSPECT_AST]
			return formatResponse.toolError(`${validation.message}${example ? `\n\nExample: ${example}` : ""}`)
		}

		const args = validation.args
		const deadline = new ToolExecutionDeadline(this.spec().name)
		let execution: InspectionExecution
		try {
			execution = await this.executeOperation(args, env, deadline)
		} catch (error) {
			if (error instanceof ToolTimeoutError) return await presentToolTimeout(env, error)
			throw error
		}
		const cards: InspectCardRecord[] = []
		const observabilityFailures: string[] = [...(execution.warnings ?? [])]
		observabilityFailures.push(...await this.createCards(args, execution.groups, env, cards))
		observabilityFailures.push(...await this.finalizeCards(cards))
		try {
			this.captureTelemetry(args, execution, env)
		} catch (error) {
			observabilityFailures.push(`telemetry failed: ${this.errorMessage(error)}`)
		}
		try {
			env.orchestration.setTaskState("consecutiveMistakeCount", 0)
		} catch (error) {
			observabilityFailures.push(`task-state update failed: ${this.errorMessage(error)}`)
		}

		const text = observabilityFailures.length > 0
			? `${execution.formatted.text}\n\nObservability warning: inspection succeeded, but ${observabilityFailures.join(" ")}`
			: execution.formatted.text
		return text
	}

	private async executeOperation(
		args: NormalizedInspectAstArgs,
		env: IToolEnvironment,
		deadline: ToolExecutionDeadline,
	): Promise<InspectionExecution> {
		if (args.operation === "outline") {
			const result = await deadline.run("inspecting source outlines", async () =>
				await env.sourceAst.outline({
					paths: args.paths,
					includeAnchors: args.includeAnchors,
					showCallGraph: true,
				}))
			const groups = this.reducer.reduceOutline(args.paths, result)
			return {
				operation: args.operation,
				result,
				groups,
				formatted: this.formatter.formatOutline(groups, args.includeAnchors),
			}
		}

		if (args.operation === "implementation") {
			const result = await deadline.run("inspecting symbol implementations", async () =>
				await env.sourceAst.implementations({
					paths: args.paths,
					symbols: args.symbols,
					includeAnchors: args.includeAnchors,
				}))
			const groups = this.reducer.reduceImplementations(args.paths, args.symbols, result)
			const cacheKeys = groups.flatMap((group) =>
				group.status === "success" ? group.matches.map(implementationCacheKey) : [],
			)
			const warnings: string[] = []
			let cache: Record<string, ImplementationCacheRecord | string> = {}
			if (cacheKeys.length > 0) {
				try {
					cache = await deadline.run("loading implementation cache entries", async () =>
						await env.context.task.getEntries<ImplementationCacheRecord | string>(IMPLEMENTATION_CACHE_KEY, cacheKeys))
				} catch (error) {
					if (error instanceof ToolTimeoutError) throw error
					warnings.push(`implementation cache load failed: ${this.errorMessage(error)}.`)
				}
			}
			const cacheBeforeFormatting = structuredClone(cache)
			const formatted = this.formatter.formatImplementations(
				groups,
				args.includeAnchors,
				cache,
				(path) => env.sourceAst.getAnchorFingerprint(path),
			)
			const cacheUpdates = Object.fromEntries(
				Object.entries(cache).filter(([key, value]) => !isDeepStrictEqual(cacheBeforeFormatting[key], value)),
			)
			if (Object.keys(cacheUpdates).length > 0) {
				try {
					await deadline.run("saving the implementation cache", async () =>
						await env.context.task.updateEntries(IMPLEMENTATION_CACHE_KEY, cacheUpdates))
				} catch (error) {
					if (error instanceof ToolTimeoutError) throw error
					warnings.push(`implementation cache save failed: ${this.errorMessage(error)}.`)
				}
			}
			return { operation: args.operation, result, groups, formatted, warnings }
		}

		const kind = args.operation === "definitions"
			? "definition"
			: args.operation === "references"
				? "reference"
				: "both"
		const result = await deadline.run(`finding symbol ${args.operation}`, async () =>
			await env.sourceAst.occurrences({
				paths: args.paths,
				symbols: args.symbols,
				kind,
				includeAnchors: args.includeAnchors,
			}))
		const groups = this.reducer.reduceOccurrences(args.operation, args.paths, args.symbols, result)
		return {
			operation: args.operation,
			result,
			groups,
			formatted: this.formatter.formatOccurrences(groups, args.operation, args.includeAnchors),
		}
	}

	private async createCards(
		args: NormalizedInspectAstArgs,
		groups: InspectAstResultGroup[],
		env: IToolEnvironment,
		records: InspectCardRecord[],
	): Promise<string[]> {
		const failures: string[] = []
		for (const group of groups) {
			try {
				const card = await env.ui.createCard({
					header: this.runningHeader(group),
					icon: this.iconFor(group.operation),
					status: CardStatus.RUNNING,
					collapsed: true,
					rawInput: group.operation === "outline"
						? {
							tool: DiracDefaultTool.INSPECT_AST,
							operation: group.operation,
							path: group.path,
							includeAnchors: args.includeAnchors,
						}
						: {
							tool: DiracDefaultTool.INSPECT_AST,
							operation: group.operation,
							paths: group.searchedPaths,
							symbol: group.symbol,
							includeAnchors: args.includeAnchors,
						},
					locations: this.locationsForGroup(group),
				})
				records.push({ group, card, finalized: false })
			} catch (error) {
				failures.push(`card creation failed for ${this.groupIdentity(group)}: ${this.errorMessage(error)}.`)
			}
		}
		return failures
	}

	private async finalizeCards(cards: InspectCardRecord[]): Promise<string[]> {
		const failures: string[] = []
		for (const record of cards) failures.push(...await this.finalizeCard(record))
		return failures
	}

	private async finalizeCard(record: InspectCardRecord): Promise<string[]> {
		if (record.finalized) return []
		const group = record.group
		const terminal = group.status === "success" ? CardStatus.SUCCESS : CardStatus.ERROR
		const count = this.countForGroup(group)
		const countText = `${count.value} ${count.label}${count.value === 1 ? "" : "s"}`
		const warningText = group.issues.length > 0
			? `; ${group.issues.length} warning${group.issues.length === 1 ? "" : "s"}`
			: ""
		const failures: string[] = []
		try {
			await record.card.update({
				header: this.completedHeader(group),
				status: terminal,
				body: group.status === "success" ? `✓ ${countText}${warningText}` : group.reason,
				rawOutput: {
					status: group.status,
					[count.key]: count.value,
					issueCount: group.issues.length,
				},
				locations: this.locationsForGroup(group),
			})
		} catch (error) {
			failures.push(`card update failed for ${this.groupIdentity(group)}: ${this.errorMessage(error)}.`)
		}
		try {
			await record.card.finalize(terminal)
			record.finalized = true
		} catch (error) {
			failures.push(`card finalization failed for ${this.groupIdentity(group)}: ${this.errorMessage(error)}.`)
		}
		return failures
	}

	private captureTelemetry(args: NormalizedInspectAstArgs, execution: InspectionExecution, env: IToolEnvironment): void {
		const summary = execution.formatted.summary
		const symbolGroups = execution.groups.filter((group): group is InspectAstImplementationGroup | InspectAstOccurrenceGroup =>
			group.operation !== "outline",
		)
		env.telemetry.captureCustomMetadata({
			operation: args.operation,
			requestedPathCount: args.paths.length,
			requestedSymbolCount: args.symbols.length,
			backendTargetCount: args.operation === "outline" ? args.paths.length : args.paths.length * args.symbols.length,
			resultGroupCount: summary.resultCount,
			successfulGroupCount: summary.successCount,
			failureGroupCount: summary.failureCount,
			issueCount: summary.issueCount,
			mixedResult: summary.mixedResult,
			includeAnchors: args.includeAnchors,
			...(args.operation === "implementation" ? {
				foundSymbols: symbolGroups.filter((group) => group.status === "success").map((group) => group.symbol),
				missingSymbols: symbolGroups.filter((group) => group.status === "failure").map((group) => group.symbol),
				cacheHitCount: execution.formatted.cacheStats.hitCount,
				cacheMissCount: execution.formatted.cacheStats.missCount,
			} : {}),
		})
	}

	private incrementMistakeCount(env: IToolEnvironment): void {
		const count = env.orchestration.getTaskState("consecutiveMistakeCount")
		env.orchestration.setTaskState("consecutiveMistakeCount", count + 1)
	}

	private iconFor(operation: InspectAstOperation): DiracIcon {
		if (operation === "outline") return DiracIcon.SKELETON_EXTRACT
		if (operation === "implementation") return DiracIcon.FUNCTION_EXTRACT
		return DiracIcon.SYMBOL_FIND
	}

	private runningHeader(group: InspectAstResultGroup): string {
		const pathLabel = this.pathLabel(group.operation === "outline" ? [group.path] : group.searchedPaths)
		if (group.operation === "outline") return `Inspecting outline of ${pathLabel}`
		if (group.operation === "implementation") return `Inspecting implementation of ${group.symbol} in ${pathLabel}`
		return `Finding ${group.operation} for ${group.symbol} in ${pathLabel}`
	}

	private completedHeader(group: InspectAstResultGroup): string {
		const pathLabel = this.pathLabel(this.completedHeaderPaths(group))
		if (group.operation === "outline") {
			return group.status === "success" ? `Inspected ${pathLabel}` : `No definitions in ${pathLabel}`
		}
		if (group.status === "failure") return `No match for ${group.symbol} in ${pathLabel}`
		if (group.operation === "implementation") return `Extracted ${group.symbol} from ${pathLabel}`
		return `Found ${group.operation} for ${group.symbol} in ${pathLabel}`
	}

	private completedHeaderPaths(group: InspectAstResultGroup): string[] {
		if (group.operation === "outline") return [group.path]
		if (group.operation === "implementation") {
			return group.matches.length > 0 ? group.matches.map((match) => match.path) : group.searchedPaths
		}
		return group.occurrences.length > 0
			? group.occurrences.map((occurrence) => occurrence.displayPath)
			: group.searchedPaths
	}

	private pathLabel(paths: string[]): string {
		const uniquePaths = [...new Set(paths)]
		const firstPath = this.truncateHeaderPath(uniquePaths[0])
		return uniquePaths.length === 1 ? firstPath : `${firstPath} (+${uniquePaths.length - 1} more)`
	}

	private truncateHeaderPath(path: string): string {
		if (path.length <= MAX_HEADER_PATH_LENGTH) return path
		const visibleLength = MAX_HEADER_PATH_LENGTH - 1
		const leadingLength = Math.ceil(visibleLength / 2)
		const trailingLength = Math.floor(visibleLength / 2)
		return `${path.slice(0, leadingLength)}…${path.slice(-trailingLength)}`
	}

	private countForGroup(group: InspectAstResultGroup): { key: string; label: string; value: number } {
		if (group.operation === "outline") {
			return { key: "definitionCount", label: "definition", value: group.file?.definitions.length ?? 0 }
		}
		if (group.operation === "implementation") {
			return { key: "matchCount", label: "match", value: group.matches.length }
		}
		const label = group.operation === "definitions"
			? "definition"
			: group.operation === "references"
				? "reference"
				: "occurrence"
		return { key: "occurrenceCount", label, value: group.occurrences.length }
	}

	private locationsForGroup(group: InspectAstResultGroup): Array<{ path: string; line?: number }> {
		if (group.operation === "outline") {
			const locations = group.file?.definitions.map((definition) => ({
				path: group.file?.path ?? group.path,
				line: definition.declarationLine + 1,
			})) ?? []
			return this.uniqueLocations(locations.length > 0 ? locations : [{ path: group.path }])
		}
		if (group.operation === "implementation") {
			const locations = group.matches.map((match) => ({
				path: match.path,
				...(match.definition ? { line: match.definition.declarationLine + 1 } : {}),
			}))
			return this.uniqueLocations(locations.length > 0 ? locations : group.searchedPaths.map((path) => ({ path })))
		}
		const locations = group.occurrences.map((occurrence) => ({
			path: occurrence.displayPath,
			line: occurrence.startLine + 1,
		}))
		return this.uniqueLocations(locations.length > 0 ? locations : group.searchedPaths.map((path) => ({ path })))
	}

	private groupIdentity(group: InspectAstResultGroup): string {
		return group.operation === "outline" ? group.path : group.symbol
	}

	private uniqueLocations(locations: Array<{ path: string; line?: number }>): Array<{ path: string; line?: number }> {
		const unique = new Map<string, { path: string; line?: number }>()
		for (const location of locations) unique.set(`${location.path}:${location.line ?? ""}`, location)
		return [...unique.values()]
	}

	private errorMessage(error: unknown): string {
		return getErrorMessage(error)
	}
}
