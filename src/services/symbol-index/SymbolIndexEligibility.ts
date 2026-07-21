import { spawn } from "node:child_process"
import * as fs from "node:fs/promises"
import * as path from "node:path"

const SUPPORTED_EXTENSIONS = new Set([
	"js",
	"jsx",
	"ts",
	"tsx",
	"py",
	"rs",
	"go",
	"c",
	"h",
	"cpp",
	"hpp",
	"cs",
	"rb",
	"java",
	"php",
	"swift",
	"kt",
])

const EXCLUDED_DIRECTORY_NAMES = new Set([
	".dirac-cache",
	".dirac-symbol-index",
	".git",
	".hg",
	".svn",
	".cache",
	".mypy_cache",
	".next",
	".nox",
	".nuxt",
	".nyc_output",
	".parcel-cache",
	".pytest_cache",
	".ruff_cache",
	".tox",
	".venv",
	".yarn",
	"__generated__",
	"__pycache__",
	"bower_components",
	"build",
	"coverage",
	"coverage-unit",
	"dist",
	"dist-standalone",
	"env",
	"generated",
	"node_modules",
	"out",
	"target",
	"test-results",
	"tmp",
	"vendor",
	"venv",
])

const EXCLUDED_FILE_NAMES = new Set([
	"Cargo.lock",
	"Gemfile.lock",
	"composer.lock",
	"go.sum",
	"mix.lock",
	"package-lock.json",
	"pnpm-lock.yaml",
	"poetry.lock",
	"yarn.lock",
])

const GIT_TIMEOUT_MS = 120_000
const GIT_MAX_OUTPUT_BYTES = 64 * 1024 * 1024

interface GitResult {
	code: number
	stdout: Buffer
	stderr: string
}

interface GitPaths {
	eligiblePaths: Set<string>
	watchDirectories: Set<string>
}

export interface SymbolIndexEligibilityResult {
	paths: Set<string>
	watchDirectories: Set<string>
	isGitWorkspace: boolean
	gitDirectory: string | null
}

export class SymbolIndexEligibility {
	public constructor(private readonly projectRoot: string) {}

	public admitsRelativePath(relativePath: string): boolean {
		const normalizedPath = path.normalize(relativePath)
		if (!normalizedPath || normalizedPath === ".." || normalizedPath.startsWith(`..${path.sep}`)) return false
		if (path.isAbsolute(normalizedPath)) return false

		const segments = normalizedPath.split(path.sep)
		if (segments.some((segment) => EXCLUDED_DIRECTORY_NAMES.has(segment))) return false
		if (EXCLUDED_FILE_NAMES.has(path.basename(normalizedPath))) return false

		const extension = path.extname(normalizedPath).toLowerCase().slice(1)
		return SUPPORTED_EXTENSIONS.has(extension)
	}

	public admitsAbsolutePath(absolutePath: string): boolean {
		return this.admitsRelativePath(path.relative(this.projectRoot, absolutePath))
	}

	public async enumerate(): Promise<SymbolIndexEligibilityResult> {
		if (await this.isGitWorkspace()) {
			const gitPaths = await this.enumerateGitPaths()
			return {
				paths: gitPaths.eligiblePaths,
				watchDirectories: gitPaths.watchDirectories,
				isGitWorkspace: true,
				gitDirectory: await this.resolveGitDirectory(),
			}
		}
		const nonGitPaths = await this.enumerateNonGitPaths()
		return {
			paths: nonGitPaths.eligiblePaths,
			watchDirectories: nonGitPaths.watchDirectories,
			isGitWorkspace: false,
			gitDirectory: null,
		}
	}

	public async isGitWorkspace(): Promise<boolean> {
		const gitStatus = await this.runGit(["rev-parse", "--is-inside-work-tree"])
		if (gitStatus.code === 0) return gitStatus.stdout.toString("utf8").trim() === "true"
		if (gitStatus.stderr.includes("not a git repository")) return false
		throw new Error(`Unable to determine Git workspace eligibility: ${gitStatus.stderr.trim()}`)
	}

	public async filterAbsolutePaths(absolutePaths: Iterable<string>): Promise<Set<string>> {
		const { paths: eligiblePaths } = await this.enumerate()
		const eligibleAbsolutePaths = new Set<string>()
		for (const absolutePath of absolutePaths) {
			const relativePath = path.normalize(path.relative(this.projectRoot, absolutePath))
			if (eligiblePaths.has(relativePath)) eligibleAbsolutePaths.add(absolutePath)
		}
		return eligibleAbsolutePaths
	}

	private async enumerateGitPaths(): Promise<GitPaths> {
		const result = await this.runGit(["ls-files", "-z", "--cached", "--others", "--exclude-standard"])
		if (result.code !== 0) throw new Error(`Git eligibility enumeration failed: ${result.stderr.trim()}`)

		const eligiblePaths = new Set<string>()
		for (const gitPath of result.stdout.toString("utf8").split("\0")) {
			if (!gitPath) continue
			const relativePath = path.normalize(gitPath)
			if (this.admitsRelativePath(relativePath)) eligiblePaths.add(relativePath)
		}
		return { eligiblePaths, watchDirectories: await this.enumerateWatchDirectories() }
	}

	private async resolveGitDirectory(): Promise<string> {
		const result = await this.runGit(["rev-parse", "--absolute-git-dir"])
		if (result.code !== 0) throw new Error(`Unable to resolve Git control directory: ${result.stderr.trim()}`)
		return path.normalize(result.stdout.toString("utf8").trim())
	}

	private async enumerateNonGitPaths(): Promise<GitPaths> {
		const eligiblePaths = new Set<string>()
		const watchDirectories = new Set<string>()
		const directories = [this.projectRoot]

		while (directories.length > 0) {
			const directory = directories.pop()!
			const relativeDirectory = path.normalize(path.relative(this.projectRoot, directory))
			if (relativeDirectory !== ".") watchDirectories.add(relativeDirectory)
			const entries = await fs.readdir(directory, { withFileTypes: true })
			for (const entry of entries) {
				if (entry.isDirectory()) {
					if (!EXCLUDED_DIRECTORY_NAMES.has(entry.name)) directories.push(path.join(directory, entry.name))
					continue
				}
				if (!entry.isFile()) continue
				const relativePath = path.normalize(path.relative(this.projectRoot, path.join(directory, entry.name)))
				if (this.admitsRelativePath(relativePath)) eligiblePaths.add(relativePath)
			}
		}
		return { eligiblePaths, watchDirectories }
	}

	private async enumerateWatchDirectories(): Promise<Set<string>> {
		const watchDirectories = new Set<string>()
		const directories = [this.projectRoot]
		while (directories.length > 0) {
			const directory = directories.pop()!
			const relativeDirectory = path.normalize(path.relative(this.projectRoot, directory))
			if (relativeDirectory !== ".") watchDirectories.add(relativeDirectory)
			for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
				if (!entry.isDirectory() || EXCLUDED_DIRECTORY_NAMES.has(entry.name)) continue
				directories.push(path.join(directory, entry.name))
			}
		}
		return watchDirectories
	}

	private addAncestorDirectories(directories: Set<string>, relativePath: string): void {
		let relativeDirectory = path.dirname(relativePath)
		while (relativeDirectory !== ".") {
			directories.add(relativeDirectory)
			const parent = path.dirname(relativeDirectory)
			if (parent === relativeDirectory) return
			relativeDirectory = parent
		}
	}

	private runGit(args: string[]): Promise<GitResult> {
		return new Promise((resolve, reject) => {
			const child = spawn("git", args, {
				cwd: this.projectRoot,
				env: { ...process.env, LC_ALL: "C" },
				stdio: ["ignore", "pipe", "pipe"],
			})
			const stdoutChunks: Buffer[] = []
			const stderrChunks: Buffer[] = []
			let outputBytes = 0
			let settled = false

			const timer = setTimeout(() => {
				child.kill()
				finish(new Error(`Git command timed out after ${GIT_TIMEOUT_MS}ms`))
			}, GIT_TIMEOUT_MS)

			const finish = (error?: Error, result?: GitResult): void => {
				if (settled) return
				settled = true
				clearTimeout(timer)
				if (error) reject(error)
				else resolve(result!)
			}

			const collect = (chunks: Buffer[], chunk: Buffer): void => {
				outputBytes += chunk.length
				if (outputBytes > GIT_MAX_OUTPUT_BYTES) {
					child.kill()
					finish(new Error(`Git command output exceeded ${GIT_MAX_OUTPUT_BYTES} bytes`))
					return
				}
				chunks.push(chunk)
			}

			child.stdout.on("data", (chunk: Buffer) => collect(stdoutChunks, chunk))
			child.stderr.on("data", (chunk: Buffer) => collect(stderrChunks, chunk))
			child.on("error", (error) => finish(error))
			child.on("close", (code) =>
				finish(undefined, {
					code: code ?? -1,
					stdout: Buffer.concat(stdoutChunks),
					stderr: Buffer.concat(stderrChunks).toString("utf8"),
				}),
			)
		})
	}
}
