import { ApiHandler } from "@core/api"
import { FileContextTracker } from "@core/context/context-tracking/FileContextTracker"
import { formatResponse } from "@core/formatResponse"
import { getEditingFilesInstructions } from "@core/prompts/system-prompt/sections/editing-files"
import type { TaskWorkingConfiguration } from "./runtime/TaskWorkingConfiguration"
import type { TaskRequestRuntime } from "./runtime/TaskRequestRuntime"
import { WorkspaceRootManager } from "@core/workspace/WorkspaceRootManager"
import { ITerminalManager } from "@integrations/terminal/types"
import type { Dirent } from "fs"
import fs from "fs/promises"
import * as path from "path"
import { MessageStateHandler } from "./message-state"
import { TaskState } from "./TaskState"

const CODE_EXTENSIONS = new Set([
	".ts",
	".tsx",
	".js",
	".jsx",
	".mjs",
	".cjs",
	".html",
	".css",
	".scss",
	".less",
	".vue",
	".svelte",
	".py",
	".rb",
	".go",
	".rs",
	".java",
	".kt",
	".swift",
	".c",
	".cpp",
	".h",
	".hpp",
	".cs",
	".m",
	".sh",
	".bash",
	".zsh",
	".fish",
	".yaml",
	".yml",
	".toml",
	".env",
	".sql",
	".json",
	".md",
	".mdx",
])

const ALWAYS_IGNORED_DIRS = new Set(["node_modules", ".git", ".next", "dist", "build", "__pycache__", ".venv", "venv", ".cache"])
const MAX_WALK_ENTRIES = 5000

function isCodeFile(filename: string): boolean {
	return CODE_EXTENSIONS.has(path.extname(filename).toLowerCase())
}

async function readDirEntries(dir: string): Promise<Dirent[]> {
	try {
		return await fs.readdir(dir, { withFileTypes: true })
	} catch {
		return []
	}
}

export interface EnvironmentManagerDependencies {
	cwd: string
	terminalManager: ITerminalManager
	taskState: TaskState
	fileContextTracker: FileContextTracker
	api: ApiHandler
	messageStateHandler: MessageStateHandler
	getWorkingConfiguration: () => TaskWorkingConfiguration
	getRequestRuntime: () => TaskRequestRuntime | undefined
	workspaceManager?: WorkspaceRootManager
}

export class EnvironmentManager {
	private dependencies: EnvironmentManagerDependencies

	constructor(dependencies: EnvironmentManagerDependencies) {
		this.dependencies = dependencies
	}

	setApi(api: ApiHandler): void {
		this.dependencies.api = api
	}

	private get cwd() {
		return this.dependencies.cwd
	}
	private get terminalManager() {
		return this.dependencies.terminalManager
	}
	private get taskState() {
		return this.dependencies.taskState
	}
	private get fileContextTracker() {
		return this.dependencies.fileContextTracker
	}
	private get api() {
		return this.dependencies.api
	}
	private get messageStateHandler() {
		return this.dependencies.messageStateHandler
	}
	private get workspaceManager() {
		return this.dependencies.workspaceManager
	}

	async getEnvironmentDetails(includeFileDetails = false): Promise<string> {
		let details = ""

		// Workspace roots (multi-root)
		details += this.formatWorkspaceRootsSection()

		if (includeFileDetails) {
			const MAX_RECENT_FILES = 10

			// Merge hardcoded ignores with .gitignore entries so we skip generated/vendor dirs
			const gitIgnoredNames = await this.getGitIgnoredNames()
			const ignoredDirs = new Set([...ALWAYS_IGNORED_DIRS, ...gitIgnoredNames])

			const fileStats: { relativePath: string; mtime: Date }[] = []
			for await (const absPath of this.walkCodeFiles(this.cwd, ignoredDirs)) {
				try {
					const stat = await fs.stat(absPath)
					fileStats.push({
						relativePath: path.relative(this.cwd, absPath),
						mtime: stat.mtime,
					})
				} catch {
					// File removed between walk and stat — skip
				}
			}

			fileStats.sort((a, b) => b.mtime.getTime() - a.mtime.getTime())
			const recent = fileStats.slice(0, MAX_RECENT_FILES)

			if (recent.length > 0) {
				details += `\n\n# Latest ${MAX_RECENT_FILES} edited files in this workspace`
				for (const { relativePath, mtime } of recent) {
					details += `\n${relativePath.toPosix()}  ${EnvironmentManager.relativeTime(mtime)}`
				}
			}
		}

		const requestRuntime = this.dependencies.getRequestRuntime()
		const mode = (requestRuntime?.workingConfiguration ?? this.dependencies.getWorkingConfiguration()).settings.mode
		const modeNotice = this.taskState.pendingModeNotice
		if (modeNotice?.mode === mode) {
			if (requestRuntime) modeNotice.includedInRequestId = requestRuntime.requestId
			details += "\n\n# Current Mode"
			if (mode === "plan") {
				details += `\nPLAN MODE\n${formatResponse.planModeInstructions()}`
			} else {
				details += `\nACT MODE\n${getEditingFilesInstructions()}`
			}
		}

		const content = details.trim()
		if (!content) return ""
		return `<environment_details>\n${content}\n</environment_details>`
	}

	private formatWorkspaceRootsSection(): string {
		const multiRootEnabled =
			(this.dependencies.getRequestRuntime()?.workingConfiguration ?? this.dependencies.getWorkingConfiguration()).executionOptions.multiRootEnabled
		const hasWorkspaceManager = !!this.workspaceManager
		const roots = hasWorkspaceManager ? this.workspaceManager!.getRoots() : []

		// Only show workspace roots if multi-root is enabled and there are multiple roots
		if (!multiRootEnabled || roots.length <= 1) {
			return ""
		}

		let section = "\n\n# Workspace Roots"

		// Format each root with its name, path, and VCS info
		for (const root of roots) {
			const name = root.name || path.basename(root.path)
			const vcs = root.vcs ? ` (${String(root.vcs)})` : ""
			section += `\n- ${name}: ${root.path}${vcs}`
		}

		// Add primary workspace information
		const primary = this.workspaceManager!.getPrimaryRoot()
		const primaryName = this.getPrimaryWorkspaceName(primary)
		section += `\n\nPrimary workspace: ${primaryName}`

		return section
	}

	private getPrimaryWorkspaceName(primary?: ReturnType<WorkspaceRootManager["getRoots"]>[0]): string {
		if (primary?.name) {
			return primary.name
		}
		if (primary?.path) {
			return path.basename(primary.path)
		}
		return path.basename(this.cwd)
	}

	private async getGitIgnoredNames(): Promise<Set<string>> {
		const ignored = new Set<string>()
		try {
			const content = await fs.readFile(path.join(this.cwd, ".gitignore"), "utf8")
			for (const raw of content.split("\n")) {
				const line = raw.trim()
				// Skip comments, empty lines, and negation patterns
				if (!line || line.startsWith("#") || line.startsWith("!")) {
					continue
				}
				// Extract the leading path segment: "dist/", "/build", "packages/generated" → "dist", "build", "packages"
				const name = line.replace(/^\//, "").split("/")[0].replace(/\/$/, "")
				if (name && !name.includes("*") && !name.includes("?")) {
					ignored.add(name)
				}
			}
		} catch {
			// .gitignore absent or unreadable — no-op
		}
		return ignored
	}

	private async *walkCodeFiles(
		root: string,
		ignoredDirs: Set<string>,
		maxEntries = MAX_WALK_ENTRIES,
	): AsyncGenerator<string> {
		const queue: string[] = [root]
		let inspected = 0

		while (queue.length > 0 && !this.taskState.abort) {
			const dir = queue.shift()!
			const entries = await readDirEntries(dir)

			for (const entry of entries) {
				if (this.taskState.abort || ++inspected > maxEntries) {
					return
				}
				if (entry.name.startsWith(".")) {
					continue
				}

				const fullPath = path.join(dir, entry.name)
				if (entry.isDirectory() && !ignoredDirs.has(entry.name)) {
					queue.push(fullPath)
				} else if (entry.isFile() && isCodeFile(entry.name)) {
					yield fullPath
				}
			}
		}
	}

	private static relativeTime(date: Date): string {
		const seconds = Math.floor((Date.now() - date.getTime()) / 1000)
		if (seconds < 60) return `${seconds} second${seconds !== 1 ? "s" : ""} ago`
		const minutes = Math.floor(seconds / 60)
		if (minutes < 60) return `${minutes} min${minutes !== 1 ? "s" : ""} ago`
		const hours = Math.floor(minutes / 60)
		if (hours < 24) return `${hours} hour${hours !== 1 ? "s" : ""} ago`
		const days = Math.floor(hours / 24)
		if (days < 30) return `${days} day${days !== 1 ? "s" : ""} ago`
		const months = Math.floor(days / 30)
		if (months < 12) return `${months} month${months !== 1 ? "s" : ""} ago`
		return `${Math.floor(months / 12)} year${Math.floor(months / 12) !== 1 ? "s" : ""} ago`
	}
}
