import { promises as fs } from "node:fs"
import { isBinaryFile } from "isbinaryfile"
import { workspaceResolver } from "@core/workspace"
import { isDirectory } from "@utils/fs"
import { arePathsEqual } from "@utils/path"
import { globby, Options } from "globby"
import * as os from "os"
import * as path from "path"
import { Logger } from "@/shared/services/Logger"

// Constants
const DEFAULT_IGNORE_DIRECTORIES = [
	"node_modules",
	"__pycache__",
	"env",
	"venv",
	"target/dependency",
	"build/dependencies",
	"dist",
	"out",
	"bundle",
	"vendor",
	"tmp",
	"temp",
	"deps",
	"Pods",
	"*.log",
]

export interface FileInfo {
	path: string
	mtime: number
	isDirectory: boolean
	lineCount?: number
}

// Helper functions
function isRestrictedPath(absolutePath: string): boolean {
	const root = process.platform === "win32" ? path.parse(absolutePath).root : "/"
	const isRoot = arePathsEqual(absolutePath, root)
	if (isRoot) {
		return true
	}

	const homeDir = os.homedir()
	const isHomeDir = arePathsEqual(absolutePath, homeDir)
	if (isHomeDir) {
		return true
	}

	return false
}

function isTargetingHiddenDirectory(absolutePath: string): boolean {
	const dirName = workspaceResolver.getBasename(absolutePath, "Services.glob.isTargetingHiddenDirectory")
	return dirName.startsWith(".")
}

function buildIgnorePatterns(absolutePath: string): string[] {
	const isTargetHidden = isTargetingHiddenDirectory(absolutePath)

	const patterns = [...DEFAULT_IGNORE_DIRECTORIES]

	// Only ignore hidden directories if we're not explicitly targeting a hidden directory
	if (!isTargetHidden) {
		patterns.push(".*")
	}

	return patterns.map((pattern) => {
		if (pattern.includes("*")) {
			return `**/${pattern}`
		}
		return `**/${pattern}/**`
	})
}

export async function listFiles(dirPath: string, recursive: boolean, limit: number): Promise<[FileInfo[], boolean]> {
	const absolutePathResult = workspaceResolver.resolveWorkspacePath(dirPath, "", "Services.glob.listFiles")
	const absolutePath = typeof absolutePathResult === "string" ? absolutePathResult : absolutePathResult.absolutePath

	// Do not allow listing files in root or home directory
	if (isRestrictedPath(absolutePath)) {
		return [[], false]
	}

	// globby requires cwd to point to a directory
	if (!(await isDirectory(absolutePath))) {
		// If it's a file, return information about that file
		try {
			const stats = await fs.stat(absolutePath)
			if (stats.isFile()) {
				let lineCount: number | undefined
				try {
					const isBinary = await isBinaryFile(absolutePath)
					if (!isBinary) {
						const content = await fs.readFile(absolutePath, "utf8")
						lineCount = (content.match(/\n/g) || []).length + 1
					}
				} catch (error) {
					// Ignore errors reading file
				}

				return [
					[
						{
							path: absolutePath,
							mtime: stats.mtimeMs,
							isDirectory: false,
							lineCount,
						},
					],
					false,
				]
			}
		} catch (error) {
			// Path does not exist or other error
		}
		return [[], false]
	}

	const ignorePatterns = buildIgnorePatterns(absolutePath)

	const options: Options = {
		cwd: absolutePath,
		dot: true, // do not ignore hidden files/directories
		absolute: true,
		markDirectories: true, // Append a / on any directories matched
		gitignore: true, // globby ignores any files that are gitignored
		ignore: ignorePatterns,
		onlyFiles: false, // include directories in results
		suppressErrors: true,
		stats: true,
	}

	const entries = recursive ? await globbyLevelByLevel(limit, options) : (await globby("*", options as any)).slice(0, limit)

	const fileInfos: FileInfo[] = await Promise.all(
		(entries as any).map(async (entry: any) => {
			const isDir = entry.path.endsWith("/")
			let lineCount: number | undefined

			if (!isDir) {
				try {
					const isBinary = await isBinaryFile(entry.path)
					if (!isBinary) {
						const content = await fs.readFile(entry.path, "utf8")
						lineCount = (content.match(/\n/g) || []).length + 1
					}
				} catch (error) {
					// Ignore errors reading file
				}
			}

			return {
				path: entry.path,
				mtime: entry.stats?.mtimeMs ?? 0,
				isDirectory: isDir,
				lineCount,
			}
		}),
	)

	return [fileInfos, fileInfos.length >= limit]
}

/*
Breadth-first traversal of directory structure level by level up to a limit:
   - Queue-based approach ensures proper breadth-first traversal
   - Processes directory patterns level by level
   - Captures a representative sample of the directory structure up to the limit
   - Minimizes risk of missing deeply nested files

- Notes:
   - Relies on globby to mark directories with /
   - Potential for loops if symbolic links reference back to parent (we could use followSymlinks: false but that may not be ideal for some projects and it's pointless if they're not using symlinks wrong)
   - Timeout mechanism prevents infinite loops
*/
async function globbyLevelByLevel(limit: number, options?: Options): Promise<any[]> {
	const results: Map<string, any> = new Map()
	const queue: string[] = ["*"]

	const globbingProcess = async () => {
		while (queue.length > 0 && results.size < limit) {
			const pattern = queue.shift()!
			const entriesAtLevel = (await globby(pattern, options as any)) as any[]

			for (const entry of entriesAtLevel) {
				if (results.size >= limit) {
					break
				}
				results.set(entry.path, entry)
				if (entry.path.endsWith("/")) {
					// Escape parentheses in the path to prevent glob pattern interpretation
					// This is crucial for NextJS folder naming conventions which use parentheses like (auth), (dashboard)
					// Without escaping, glob treats parentheses as special pattern grouping characters
					const escapedFile = entry.path.replace(/\(/g, "\\(").replace(/\)/g, "\\)")
					queue.push(`${escapedFile}*`)
				}
			}
		}
		return Array.from(results.values()).slice(0, limit)
	}

	// Timeout after 10 seconds and return partial results
	const timeoutPromise = new Promise<any[]>((_, reject) => {
		setTimeout(() => reject(new Error("Globbing timeout")), 10_000)
	})

	try {
		return await Promise.race([globbingProcess(), timeoutPromise])
	} catch (_error) {
		Logger.warn("Globbing timed out, returning partial results")
		return Array.from(results.values())
	}
}
