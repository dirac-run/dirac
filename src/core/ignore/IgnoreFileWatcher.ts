import path from "path"
import { Logger } from "@/shared/services/Logger"
import { ChokidarWatcherCloser } from "@/shared/utils/ChokidarWatcherCloser"
import { type WatcherFactory } from "./IgnorePatterns"

/**
 * Watches the .diracignore file in `cwd` and invokes `onReload` whenever it changes,
 * is created, or is deleted. Owns the underlying chokidar FSWatcher lifecycle.
 */
export class IgnoreFileWatcher {
	private watcher?: ReturnType<WatcherFactory>
	private readonly watcherCloser = new ChokidarWatcherCloser()
	private disposed = false

	constructor(
		private readonly cwd: string,
		private readonly watcherFactory: WatcherFactory,
	) { }

	async start(onReload: () => Promise<void> | void): Promise<void> {
		if (this.disposed) return
		await this.watcherCloser.closeAll()
		if (this.disposed || this.watcher) return
		const ignorePath = path.join(this.cwd, ".diracignore")
		try {
			const watcher = this.watcherFactory(ignorePath, {
				persistent: true, // Keep the process running as long as files are being watched
				ignoreInitial: true, // Don't fire 'add' events when discovering the file initially
				awaitWriteFinish: {
					// Wait for writes to finish before emitting events (handles chunked writes)
					stabilityThreshold: 100, // Wait 100ms for file size to remain constant
					pollInterval: 100, // Check file size every 100ms while waiting for stability
				},
				atomic: true, // Handle atomic writes where editors write to a temp file then rename
			})
			this.watcher = watcher
			const reload = () => {
				if (this.watcher !== watcher) return
				try {
					void Promise.resolve(onReload()).catch((reloadError) =>
						Logger.error("Failed to reload .diracignore after file change:", reloadError),
					)
				} catch (reloadError) {
					Logger.error("Failed to reload .diracignore after file change:", reloadError)
				}
			}
			watcher.on("error", (error) => {
				if (this.watcher !== watcher) return
				this.watcher = undefined
				Logger.error("Error watching .diracignore file; live reload is disabled:", error)
				void this.watcherCloser
					.close(watcher)
					.catch((closeError) => Logger.error("Failed to close disabled .diracignore watcher:", closeError))
			})
			watcher.on("change", reload)
			watcher.on("add", reload)
			watcher.on("unlink", reload)
		} catch (error) {
			this.watcher = undefined
			Logger.error("Failed to start .diracignore watcher; live reload is disabled:", error)
		}
	}

	async dispose(): Promise<void> {
		this.disposed = true
		const watcher = this.watcher
		this.watcher = undefined
		await this.watcherCloser.closeAll(watcher ? [watcher] : [])
	}
}
