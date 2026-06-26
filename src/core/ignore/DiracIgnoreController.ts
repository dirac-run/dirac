import { fileExistsAtPath } from "@utils/fs"
import chokidar from "chokidar"
import fs from "fs/promises"
import ignore, { type Ignore } from "ignore"
import path from "path"
import { Logger } from "@/shared/services/Logger"
import { findBlockedCommandArgument } from "./CommandAccessValidator"
import { IgnoreFileWatcher } from "./IgnoreFileWatcher"
import { parseIgnoreContent } from "./IgnorePatternParser"
import type { WatcherFactory } from "./IgnorePatterns"
import { DEFAULT_IGNORE_PATTERNS } from "./IgnorePatterns"

export type { WatcherFactory } from "./IgnorePatterns"
// Re-export public API symbols so existing import sites keep working
export { LOCK_TEXT_SYMBOL } from "./IgnorePatterns"

/**
 * Orchestrates .diracignore loading, file watching, and access validation.
 * Pattern parsing, include resolution, file watching, and command validation
 * are delegated to focused collaborators.
 */
export class DiracIgnoreController {
	public yoloMode = false
	diracIgnoreContent: string | undefined

	private readonly cwd: string
	private ignoreInstance: Ignore
	private fileWatcher?: IgnoreFileWatcher

	constructor(cwd: string, watcherFactory: WatcherFactory = chokidar.watch) {
		this.cwd = cwd
		this.ignoreInstance = ignore()
		this.ignoreInstance.add(DEFAULT_IGNORE_PATTERNS)
		this.diracIgnoreContent = undefined
		this.fileWatcher = new IgnoreFileWatcher(cwd, watcherFactory)
	}

	/** Load custom patterns and start watching .diracignore for changes. Must be called after construction. */
	async initialize(): Promise<void> {
		this.fileWatcher?.start(() => this.loadDiracIgnore())
		await this.loadDiracIgnore()
	}

	/** Reload .diracignore from disk, resolving !include directives into the ignore instance. */
	private async loadDiracIgnore(): Promise<void> {
		try {
			this.resetIgnoreInstance()
			const ignorePath = path.join(this.cwd, ".diracignore")
			if (!(await fileExistsAtPath(ignorePath))) {
				this.diracIgnoreContent = undefined
				return
			}
			const content = await fs.readFile(ignorePath, "utf8")
			this.diracIgnoreContent = content
			const combinedContent = await parseIgnoreContent(content, this.cwd)
			this.ignoreInstance.add(combinedContent)
			this.ignoreInstance.add(".diracignore")
		} catch (error) {
			// Should never happen: reading file failed even though it exists
			Logger.error("Unexpected error loading .diracignore:", error)
		}
	}

	// Reset ignore instance to prevent duplicate patterns on reload
	private resetIgnoreInstance(): void {
		this.ignoreInstance = ignore()
		this.ignoreInstance.add(DEFAULT_IGNORE_PATTERNS)
	}

	/** True if `filePath` is accessible (not ignored); paths outside cwd are allowed. */
	validateAccess(filePath: string): boolean {
		if (this.yoloMode) {
			return true
		}
		try {
			// Normalize path to be relative to cwd and use forward slashes; ignore expects relative paths
			const absolutePath = path.resolve(this.cwd, filePath)
			const relativePath = path.relative(this.cwd, absolutePath).toPosix()
			return !this.ignoreInstance.ignores(relativePath)
		} catch (_error) {
			// ignore throws for paths outside cwd; we allow access to all files outside cwd
			return true
		}
	}

	/** Returns the first blocked file argument in a file-reading command, or undefined if allowed. */
	validateCommand(command: string): string | undefined {
		if (this.yoloMode) {
			return undefined
		}
		return findBlockedCommandArgument(command, (p) => this.validateAccess(p))
	}

	/** Filter an array of paths, removing those that are ignored. Fails closed for security. */
	filterPaths(paths: string[]): string[] {
		try {
			return paths.filter((p) => this.validateAccess(p))
		} catch (error) {
			Logger.error("Error filtering paths:", error)
			return [] // Fail closed for security
		}
	}

	async dispose(): Promise<void> {
		await this.fileWatcher?.dispose()
		this.fileWatcher = undefined
	}
}
