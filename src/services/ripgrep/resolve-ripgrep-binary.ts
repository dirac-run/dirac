import { execFile } from "node:child_process"
import path from "node:path"
import { promisify } from "node:util"
import { Logger } from "@/shared/services/Logger"

const execFileAsync = promisify(execFile)
const RIPGREP_PROBE_TIMEOUT_MS = 5_000

const bundledRipgrepRelativePaths: Record<string, string> = {
	"darwin-arm64": path.join("ripgrep-binaries", "darwin-arm64", "rg"),
	"linux-x64": path.join("ripgrep-binaries", "linux-x64", "rg"),
	"win32-x64": path.join("ripgrep-binaries", "win-x64", "rg.exe"),
}

export interface ResolvedRipgrepBinary {
	path: string
	source: "bundled" | "system PATH"
}

export async function resolveWorkingRipgrepBinary(extensionFsPath: string): Promise<ResolvedRipgrepBinary> {
	const platformKey = `${process.platform}-${process.arch}`
	const bundledRelativePath = bundledRipgrepRelativePaths[platformKey]

	if (bundledRelativePath) {
		const bundledPath = path.join(extensionFsPath, "dist", bundledRelativePath)
		if (await validateRipgrepBinary(bundledPath, "bundled")) {
			return { path: bundledPath, source: "bundled" }
		}
	} else {
		Logger.info(`[Dirac] No bundled rg binary is available for ${platformKey}`)
	}

	for (const systemPath of await findSystemRipgrepPaths()) {
		if (await validateRipgrepBinary(systemPath, "system PATH")) {
			return { path: systemPath, source: "system PATH" }
		}
	}

	const installHint = process.platform === "darwin" ? " Install ripgrep with: brew install ripgrep." : ""
	throw new Error(`Could not find a working ripgrep binary for ${platformKey}.${installHint}`)
}

async function validateRipgrepBinary(binaryPath: string, source: string): Promise<boolean> {
	try {
		await execFileAsync(binaryPath, ["--version"], {
			encoding: "utf8",
			maxBuffer: 8 * 1024,
			timeout: RIPGREP_PROBE_TIMEOUT_MS,
			windowsHide: true,
		})
		return true
	} catch (error) {
		const reason = error instanceof Error ? error.message : String(error)
		Logger.warn(`[Dirac] ${source} rg failed validation at ${binaryPath}: ${reason}`)
		return false
	}
}

async function findSystemRipgrepPaths(): Promise<string[]> {
	const isWindows = process.platform === "win32"
	const locator = isWindows ? "where" : "which"
	const binaryName = isWindows ? "rg.exe" : "rg"

	try {
		const { stdout } = await execFileAsync(locator, [binaryName], {
			encoding: "utf8",
			maxBuffer: 8 * 1024,
			windowsHide: true,
		})
		return stdout
			.split(/\r?\n/)
			.map((candidate) => candidate.trim())
			.filter(Boolean)
	} catch {
		return []
	}
}
