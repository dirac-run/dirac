import { Logger } from "@/shared/services/Logger"

interface SymbolIndexTelemetryCounters {
	watcherEvents: number
	watcherRejected: number
	dirtySetHighWaterMark: number
	updateRuns: number
	sizeSkips: number
	minifiedSkips: number
	grammarLoads: number
	reconciliations: number
	eligibleFiles: number
	removedFiles: number
	updatedFiles: number
	failures: number
}

const createCounters = (): SymbolIndexTelemetryCounters => ({
	watcherEvents: 0,
	watcherRejected: 0,
	dirtySetHighWaterMark: 0,
	updateRuns: 0,
	sizeSkips: 0,
	minifiedSkips: 0,
	grammarLoads: 0,
	reconciliations: 0,
	eligibleFiles: 0,
	removedFiles: 0,
	updatedFiles: 0,
	failures: 0,
})

export class SymbolIndexTelemetry {
	private static counters = createCounters()

	public static recordWatcherEvent(): void {
		SymbolIndexTelemetry.counters.watcherEvents++
	}

	public static recordWatcherRejected(): void {
		SymbolIndexTelemetry.counters.watcherRejected++
	}

	public static recordDirtySetSize(size: number): void {
		SymbolIndexTelemetry.counters.dirtySetHighWaterMark = Math.max(SymbolIndexTelemetry.counters.dirtySetHighWaterMark, size)
	}

	public static recordUpdateRun(): void {
		SymbolIndexTelemetry.counters.updateRuns++
	}

	public static recordSizeSkip(): void {
		SymbolIndexTelemetry.counters.sizeSkips++
	}

	public static recordMinifiedSkip(): void {
		SymbolIndexTelemetry.counters.minifiedSkips++
	}

	public static recordGrammarLoad(): void {
		SymbolIndexTelemetry.counters.grammarLoads++
	}

	public static recordReconciliation(eligible: number, removed: number, updated: number): void {
		SymbolIndexTelemetry.counters.reconciliations++
		SymbolIndexTelemetry.counters.eligibleFiles += eligible
		SymbolIndexTelemetry.counters.removedFiles += removed
		SymbolIndexTelemetry.counters.updatedFiles += updated
	}

	public static recordUpdateFailure(): void {
		SymbolIndexTelemetry.recordFailure()
	}

	public static recordFailure(): void {
		SymbolIndexTelemetry.counters.failures++
	}

	public static logSummary(reason: "periodic" | "deactivation"): void {
		const counters = SymbolIndexTelemetry.counters
		if (Object.values(counters).every((value) => value === 0)) return

		Logger.info(
			`[SymbolIndex] ${reason} summary events=${counters.watcherEvents} rejected=${counters.watcherRejected} dirtyHighWater=${counters.dirtySetHighWaterMark} updates=${counters.updateRuns} sizeSkips=${counters.sizeSkips} minifiedSkips=${counters.minifiedSkips} grammarLoads=${counters.grammarLoads} reconciliations=${counters.reconciliations} eligible=${counters.eligibleFiles} removed=${counters.removedFiles} indexed=${counters.updatedFiles} failures=${counters.failures}`,
		)
		SymbolIndexTelemetry.counters = createCounters()
	}
}
