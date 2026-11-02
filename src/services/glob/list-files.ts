import { createReadStream, promises as fs } from "node:fs"
import { requireWorkspacePathResolver } from "@shared/workspace/workspace-path-resolver"
import { arePathsEqual } from "@utils/path"
import { runWorkspaceGit, walkWorkspace } from "@utils/workspaceTraversal"
import { isBinaryFile } from "isbinaryfile"
import * as os from "os"
import * as path from "path"
import picomatch from "picomatch"
import { Logger } from "@/shared/services/Logger"

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

function isRestrictedPath(absolutePath: string): boolean {
	return arePathsEqual(absolutePath, path.parse(absolutePath).root) || arePathsEqual(absolutePath, os.homedir())
}

function buildIgnorePatterns(absolutePath: string): string[] {
	const patterns = [...DEFAULT_IGNORE_DIRECTORIES]
	if (!path.basename(absolutePath).startsWith(".")) patterns.push(".*")
	return patterns.flatMap((pattern) => [`**/${pattern}`, `**/${pattern}/**`])
}

async function describeFile(absolutePath: string, signal: AbortSignal, followSymlink = false): Promise<FileInfo> {
	signal.throwIfAborted()
	const stats = followSymlink ? await fs.stat(absolutePath) : await fs.lstat(absolutePath)
	let lineCount: number | undefined
	if (stats.isFile() && !(await isBinaryFile(absolutePath))) {
		lineCount = 1
		for await (const chunk of createReadStream(absolutePath, { signal })) {
			for (const byte of chunk as Buffer) if (byte === 10) lineCount++
		}
	}
	return {
		path: absolutePath + (stats.isDirectory() ? "/" : ""),
		mtime: stats.mtimeMs,
		isDirectory: stats.isDirectory(),
		lineCount,
	}
}

export async function listFiles(dirPath: string, recursive: boolean, limit: number): Promise<[FileInfo[], boolean]> {
	const resolved = requireWorkspacePathResolver().resolveWorkspacePath(dirPath, "", "Services.glob.listFiles")
	const absolutePath = typeof resolved === "string" ? resolved : resolved.absolutePath
	if (isRestrictedPath(absolutePath)) return [[], false]
	if (limit <= 0) return [[], true]

	const controller = new AbortController()
	const timeout = setTimeout(() => controller.abort(new Error("File listing timed out")), 10_000)
	const results: FileInfo[] = []
	try {
		const stats = await fs.stat(absolutePath)
		if (!stats.isDirectory()) return [[await describeFile(absolutePath, controller.signal, true)], false]
		const isIgnored = picomatch(buildIgnorePatterns(absolutePath), { dot: true })
		for await (const entry of walkWorkspace(absolutePath, {
			signal: controller.signal,
			allowIgnoredRoot: true,
			recursive,
			excludes: (entry) => isIgnored(entry.relativePath.split(path.sep).join("/")),
		})) {
			results.push(await describeFile(entry.absolutePath, controller.signal))
			if (results.length >= limit) return [results, true]
		}
		return [results, false]
	} catch (error) {
		if (controller.signal.aborted) {
			Logger.warn("File listing timed out; traversal stopped, returning partial results")
			return [results, true]
		}
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return [results, results.length > 0]
		throw error
	} finally {
		clearTimeout(timeout)
	}
}

/** Targeted path-only discovery; never reads unrelated file contents or caps rules at a general listing limit. */
export async function findFilesByName(root: string, name: string): Promise<string[]> {
	const signal = AbortSignal.timeout(10_000)
	const isIgnored = picomatch(buildIgnorePatterns(root), { dot: true })
	let result: Awaited<ReturnType<typeof runWorkspaceGit>> | undefined
	try {
		result = await runWorkspaceGit(
			root,
			["ls-files", "-z", "--cached", "--others", "--exclude-standard", "--", `:(glob,icase)**/${name}`],
			signal,
		)
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
	}
	if (result?.code === 0) {
		const candidates = [...new Set(result.stdout.split("\0").filter((file) => file && !isIgnored(file)))]
		const files: string[] = []
		for (const file of candidates) {
			signal.throwIfAborted()
			const absolutePath = path.join(root, file)
			try {
				if ((await fs.lstat(absolutePath)).isFile()) files.push(absolutePath)
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
			}
		}
		return files.sort()
	}
	if (result && !result.stderr.includes("not a git repository")) throw new Error(`Rule file discovery failed: ${result.stderr}`)
	const files: string[] = []
	for await (const entry of walkWorkspace(root, {
		signal,
		excludes: (entry) => isIgnored(entry.relativePath.split(path.sep).join("/")),
	})) {
		if (entry.dirent.isFile() && entry.dirent.name.toLowerCase() === name.toLowerCase()) files.push(entry.absolutePath)
	}
	return files.sort()
}
