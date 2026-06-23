import path from "path"
import { Logger } from "@/shared/services/Logger"
import { type WatcherFactory } from "./IgnorePatterns"

/**
 * Watches the .diracignore file in `cwd` and invokes `onReload` whenever it changes,
 * is created, or is deleted. Owns the underlying chokidar FSWatcher lifecycle.
 */
export class IgnoreFileWatcher {
	private watcher?: ReturnType<WatcherFactory>

	constructor(
		private readonly cwd: string,
		private readonly watcherFactory: WatcherFactory,
	) {}

	start(onReload: () => Promise<void> | void): void {
		const ignorePath = path.join(this.cwd, ".diracignore")
		this.watcher = this.watcherFactory(ignorePath, {
			persistent: true, // Keep the process running as long as files are being watched
			ignoreInitial: true, // Don't fire 'add' events when discovering the file initially
			awaitWriteFinish: {
				// Wait for writes to finish before emitting events (handles chunked writes)
				stabilityThreshold: 100, // Wait 100ms for file size to remain constant
				pollInterval: 100, // Check file size every 100ms while waiting for stability
			},
			atomic: true, // Handle atomic writes where editors write to a temp file then rename
		})

		this.watcher.on("change", onReload)
		this.watcher.on("add", onReload)
		this.watcher.on("unlink", onReload)
		this.watcher.on("error", (error) => Logger.error("Error watching .diracignore file:", error))
	}

	async dispose(): Promise<void> {
		if (!this.watcher) {
			return
		}
		await this.watcher.close()
		this.watcher = undefined
	}
}
