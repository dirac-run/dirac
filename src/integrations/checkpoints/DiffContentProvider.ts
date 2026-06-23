import fs from "fs/promises"
import { isBinaryFile } from "isbinaryfile"
import * as path from "path"
import type { SimpleGit } from "simple-git"
import { Logger } from "@/shared/services/Logger"

export interface DiffEntry {
	relativePath: string
	absolutePath: string
	before: string
	after: string
}

/**
 * Normalizes whitespace for diff comparison. Collapses all runs of whitespace
 * (spaces, tabs, newlines) into a single space and trims, so files that differ
 * only in indentation style (e.g. tabs vs spaces) are treated as identical.
 */
function normalizeWhitespace(s: string): string {
	return s.replace(/\s+/g, " ").trim()
}

/**
 * Checks if a file path matches any of the exclusion patterns.
 */
function isExcluded(filePath: string, exclusions: string[]): boolean {
	return exclusions.some((pattern) => {
		if (pattern.endsWith("/")) {
			return filePath.startsWith(pattern)
		}
		if (pattern.startsWith("*.")) {
			return filePath.endsWith(pattern.slice(1))
		}
		return filePath === pattern
	})
}

/**
 * Determines if a file should be treated as binary based on extension.
 */
function hasExtension(filePath: string): boolean {
	const lastDotIndex = filePath.lastIndexOf(".")
	const lastSlashIndex = Math.max(filePath.lastIndexOf("/"), filePath.lastIndexOf("\\"))
	return lastDotIndex > lastSlashIndex
}

/**
 * Determines if a file is a dotfile (e.g. .gitignore, .env).
 */
function isDotfile(filePath: string): boolean {
	const lastDotIndex = filePath.lastIndexOf(".")
	const lastSlashIndex = Math.max(filePath.lastIndexOf("/"), filePath.lastIndexOf("\\"))
	return lastDotIndex !== -1 && lastDotIndex === lastSlashIndex + 1
}

/**
 * Extracts file extension from a path.
 */
function getExtension(filePath: string): string {
	const lastDotIndex = filePath.lastIndexOf(".")
	const lastSlashIndex = Math.max(filePath.lastIndexOf("/"), filePath.lastIndexOf("\\"))
	return lastDotIndex > lastSlashIndex ? filePath.substring(lastDotIndex).toLowerCase() : ""
}

/**
 * DiffContentProvider — Extracted from CheckpointTracker.getDiffSet/getDiffCount.
 *
 * Responsible for:
 * - Computing diff sets between git commits or working directory
 * - Filtering by exclusion patterns (node_modules, *.lock, etc.)
 * - Binary file detection and skipping
 * - Whitespace-normalized equality checking
 * - Content retrieval via git show or filesystem read
 */
export class DiffContentProvider {
	constructor(
		private cwd: string,
		private taskId: string,
	) {}

	/** Strips "HEAD " prefix from commit hashes for backward compatibility. */
	cleanCommitHash(hash: string): string {
		return hash.replace(/^HEAD\s+/, "")
	}

	/** Shared setup: stage changes, get diff summary, load exclusions, capture telemetry. */
	private async prepareDiff(git: SimpleGit, lhsHash: string, rhsHash?: string) {
		const startTime = performance.now()
		const cleanLhs = this.cleanCommitHash(lhsHash)
		const cleanRhs = rhsHash ? this.cleanCommitHash(rhsHash) : undefined
		const diffRange = cleanRhs ? `${cleanLhs}..${cleanRhs}` : cleanLhs

		await git.add(["."])
		const diffSummary = await git.diffSummary([diffRange])

		const { getDefaultExclusions, getLfsPatterns } = await import("./CheckpointExclusions")
		const lfsPatterns = await getLfsPatterns(this.cwd)
		const exclusions = getDefaultExclusions(lfsPatterns)

		const captureTelemetry = () => {
			const durationMs = Math.round(performance.now() - startTime)
			import("@/services/telemetry")
				.then(({ telemetryService }) =>
					telemetryService.captureCheckpointUsage(this.taskId, "diff_generated", durationMs),
				)
				.catch(() => Logger.debug("[DiffContentProvider] Telemetry service not available"))
		}

		return { cleanLhs, cleanRhs, diffSummary, exclusions, captureTelemetry }
	}

	/** Computes the full diff set between two commits — returns files with actual content differences. */
	async computeDiffSet(git: SimpleGit, lhsHash: string, rhsHash?: string): Promise<DiffEntry[]> {
		const { cleanLhs, cleanRhs, diffSummary, exclusions, captureTelemetry } = await this.prepareDiff(git, lhsHash, rhsHash)

		const result: DiffEntry[] = []
		for (const file of diffSummary.files) {
			const filePath = file.file
			const absolutePath = path.join(this.cwd, filePath)

			if (isExcluded(filePath, exclusions)) continue

			// For extensionless files or dotfiles: check if binary
			if (!hasExtension(filePath) || isDotfile(filePath)) {
				try {
					const ext = getExtension(filePath)
					const isBinary = !ext ? await isBinaryFile(absolutePath).catch(() => false) : false
					if (isBinary && !ext) continue
				} catch {
					continue
				}
			}

			let beforeContent = ""
			try {
				beforeContent = await git.show([`${cleanLhs}:${filePath}`])
			} catch {
				/* file didn't exist in older commit */
			}

			let afterContent = ""
			if (rhsHash) {
				try {
					afterContent = await git.show([`${cleanRhs}:${filePath}`])
				} catch {
					/* file didn't exist in newer commit */
				}
			} else {
				try {
					afterContent = await fs.readFile(absolutePath, "utf8")
				} catch {
					/* file might be deleted */
				}
			}

			// Skip files that differ only in whitespace
			if (normalizeWhitespace(beforeContent) === normalizeWhitespace(afterContent)) continue

			result.push({ relativePath: filePath, absolutePath, before: beforeContent, after: afterContent })
		}

		captureTelemetry()
		return result
	}

	/** Returns the count of changed files, applying the same exclusion filtering as computeDiffSet. */
	async computeDiffCount(git: SimpleGit, lhsHash: string, rhsHash?: string): Promise<number> {
		const { diffSummary, exclusions, captureTelemetry } = await this.prepareDiff(git, lhsHash, rhsHash)

		let count = 0
		for (const file of diffSummary.files) {
			if (!isExcluded(file.file, exclusions)) count++
		}

		captureTelemetry()
		return count
	}
}
