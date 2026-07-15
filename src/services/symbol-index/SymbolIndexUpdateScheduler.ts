import { Logger } from "@/shared/services/Logger";
import { SymbolIndexTelemetry } from "./SymbolIndexTelemetry";

export interface SymbolIndexUpdateSchedulerDependencies {
	shouldIndexPath(absolutePath: string): boolean;
	updateFile(absolutePath: string): Promise<void>;
	removeFile(absolutePath: string): Promise<void>;
	requestFullRescan(): void;
}

/**
 * Coalesces watcher bursts before they reach the indexer. The dirty queue is capped,
 * and no more than two updateFile calls execute at once.
 */
export class SymbolIndexUpdateScheduler {
	private static readonly DEBOUNCE_MS = 1000;
	private static readonly MAX_DIRTY_PATHS = 500;
	private static readonly UPDATE_CONCURRENCY = 2;
	private static readonly TELEMETRY_INTERVAL_MS = 60_000;

	private readonly debounceMap = new Map<string, NodeJS.Timeout>();
	private readonly dirtyPaths = new Set<string>();
	private activeUpdates = 0;
	private needsFullRescan = false;
	private disposed = false;
	private readonly telemetryTimer: NodeJS.Timeout;

	public constructor(
		private readonly dependencies: SymbolIndexUpdateSchedulerDependencies,
	) {
		this.telemetryTimer = setInterval(
			() => SymbolIndexTelemetry.logSummary("periodic"),
			SymbolIndexUpdateScheduler.TELEMETRY_INTERVAL_MS,
		);
		this.telemetryTimer.unref();
	}

	public scheduleUpdate(absolutePath: string): void {
		if (this.disposed) return;
		SymbolIndexTelemetry.recordWatcherEvent();
		if (!this.dependencies.shouldIndexPath(absolutePath)) {
			SymbolIndexTelemetry.recordWatcherRejected();
			return;
		}

		const existingTimer = this.debounceMap.get(absolutePath);
		if (existingTimer) {
			clearTimeout(existingTimer);
		} else if (
			this.debounceMap.size >= SymbolIndexUpdateScheduler.MAX_DIRTY_PATHS
		) {
			this.markOverflow();
			return;
		}

		const timer = setTimeout(() => {
			this.debounceMap.delete(absolutePath);
			this.addDirtyPath(absolutePath);
		}, SymbolIndexUpdateScheduler.DEBOUNCE_MS);
		this.debounceMap.set(absolutePath, timer);
	}

	public removeFile(absolutePath: string): void {
		this.cancelUpdate(absolutePath);
		void this.dependencies.removeFile(absolutePath).catch((error) => {
			SymbolIndexTelemetry.recordUpdateFailure();
			Logger.debug(`[SymbolIndex] Failed to remove ${absolutePath}:`, error);
		});
	}

	public dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		for (const timer of this.debounceMap.values()) {
			clearTimeout(timer);
		}
		this.debounceMap.clear();
		this.dirtyPaths.clear();
		clearInterval(this.telemetryTimer);
		SymbolIndexTelemetry.logSummary("deactivation");
	}

	private cancelUpdate(absolutePath: string): void {
		const timer = this.debounceMap.get(absolutePath);
		if (timer) {
			clearTimeout(timer);
			this.debounceMap.delete(absolutePath);
		}
		this.dirtyPaths.delete(absolutePath);
	}

	private addDirtyPath(absolutePath: string): void {
		if (this.disposed) return;
		if (this.dirtyPaths.size >= SymbolIndexUpdateScheduler.MAX_DIRTY_PATHS) {
			this.markOverflow();
			return;
		}
		this.dirtyPaths.add(absolutePath);
		SymbolIndexTelemetry.recordDirtySetSize(this.dirtyPaths.size);
		this.startDrain();
	}

	private markOverflow(): void {
		for (const timer of this.debounceMap.values()) {
			clearTimeout(timer);
		}
		this.debounceMap.clear();
		this.dirtyPaths.clear();
		this.needsFullRescan = true;
		this.startDrain();
	}

	private startDrain(): void {
		if (this.disposed) return;

		while (
			this.activeUpdates < SymbolIndexUpdateScheduler.UPDATE_CONCURRENCY &&
			this.dirtyPaths.size > 0
		) {
			const [absolutePath] = this.dirtyPaths;
			this.dirtyPaths.delete(absolutePath);
			this.activeUpdates++;
			SymbolIndexTelemetry.recordUpdateRun();
			void this.runUpdate(absolutePath);
		}

		if (this.activeUpdates === 0 && this.needsFullRescan) {
			this.needsFullRescan = false;
			this.dependencies.requestFullRescan();
		}
	}

	private async runUpdate(absolutePath: string): Promise<void> {
		try {
			await this.dependencies.updateFile(absolutePath);
		} catch (error) {
			SymbolIndexTelemetry.recordUpdateFailure();
			Logger.debug(`[SymbolIndex] Failed to update ${absolutePath}:`, error);
		} finally {
			this.activeUpdates--;
			this.startDrain();
		}
	}
}
