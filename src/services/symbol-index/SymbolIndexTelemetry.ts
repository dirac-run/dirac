import { Logger } from "@/shared/services/Logger";

interface SymbolIndexTelemetryCounters {
  watcherEvents: number;
  watcherRejected: number;
  dirtySetHighWaterMark: number;
  updateRuns: number;
  sizeSkips: number;
  minifiedSkips: number;
  updateFailures: number;
  grammarLoads: number;
}

const createCounters = (): SymbolIndexTelemetryCounters => ({
  watcherEvents: 0,
  watcherRejected: 0,
  dirtySetHighWaterMark: 0,
  updateRuns: 0,
  sizeSkips: 0,
  minifiedSkips: 0,
  updateFailures: 0,
  grammarLoads: 0,
});

/** Collects low-cost operational counters without emitting per-file log noise. */
export class SymbolIndexTelemetry {
  private static counters = createCounters();

  public static recordWatcherEvent(): void {
    SymbolIndexTelemetry.counters.watcherEvents++;
  }

  public static recordWatcherRejected(): void {
    SymbolIndexTelemetry.counters.watcherRejected++;
  }

  public static recordDirtySetSize(size: number): void {
    SymbolIndexTelemetry.counters.dirtySetHighWaterMark = Math.max(
      SymbolIndexTelemetry.counters.dirtySetHighWaterMark,
      size,
    );
  }

  public static recordUpdateRun(): void {
    SymbolIndexTelemetry.counters.updateRuns++;
  }

  public static recordSizeSkip(): void {
    SymbolIndexTelemetry.counters.sizeSkips++;
  }

  public static recordMinifiedSkip(): void {
    SymbolIndexTelemetry.counters.minifiedSkips++;
  }

  public static recordUpdateFailure(): void {
    SymbolIndexTelemetry.counters.updateFailures++;
  }

  public static recordGrammarLoad(): void {
    SymbolIndexTelemetry.counters.grammarLoads++;
  }

  public static logSummary(reason: "periodic" | "deactivation"): void {
    const counters = SymbolIndexTelemetry.counters;
    if (Object.values(counters).every((value) => value === 0)) return;

    Logger.info(
      `[SymbolIndex] ${reason} summary events=${counters.watcherEvents} rejected=${counters.watcherRejected} dirtyHighWater=${counters.dirtySetHighWaterMark} updates=${counters.updateRuns} sizeSkips=${counters.sizeSkips} minifiedSkips=${counters.minifiedSkips} failures=${counters.updateFailures} grammarLoads=${counters.grammarLoads}`,
    );
    SymbolIndexTelemetry.counters = createCounters();
  }
}
