import { execFileSync } from "node:child_process"
import { accessSync, constants } from "node:fs"
import os from "node:os"
import path from "node:path"
import { rgPath } from "@vscode/ripgrep"

const data = process.env.DIRAC_DATA_DIR ?? path.join(os.homedir(), ".dirac", "data")

const log = process.env.DIRAC_LOG_DIR ?? path.join(data, "logs")

export const DIRAC_CLI_DIR = {
	data,
	log,
	cliLog: path.join(log, "dirac-cli.log"),
	acpLog: path.join(log, "dirac-acp.log"),
}

/**
 * Find binary location for CLI.
 * First checks system PATH (for brew users), then falls back to bundled @vscode/ripgrep.
 */
export async function getCliBinaryPath(name: string): Promise<string> {
	if (!name.startsWith("rg")) {
		throw new Error(`Binary '${name}' is not supported`)
	}

	const checkedPaths: string[] = []
	const isWindows = process.platform === "win32"
	const whichCommand = isWindows ? "where" : "which"
	const accessMode = isWindows ? constants.F_OK : constants.X_OK
	const binaryNames = isWindows && !name.endsWith(".exe") ? [name, `${name}.exe`] : [name]

	const isExecutable = (binPath: string) => {
		checkedPaths.push(binPath)
		try {
			accessSync(binPath, accessMode)
			return true
		} catch {
			return false
		}
	}

	for (const binaryName of binaryNames) {
		try {
			const result = execFileSync(whichCommand, [binaryName], {
				encoding: "utf-8",
				stdio: ["pipe", "pipe", "pipe"],
			})
			const binPath = result.trim().split("\n")[0].trim()
			if (binPath && isExecutable(binPath)) {
				return binPath
			}
		} catch {
			// Binary not found in PATH, fall through to bundled version.
		}
	}

	if (rgPath && isExecutable(rgPath)) {
		return rgPath
	}

	const installHint = process.platform === "darwin" ? " Install ripgrep with: brew install ripgrep." : ""
	throw new Error(`Could not find an executable ripgrep binary. Checked paths: ${checkedPaths.join(", ")}.${installHint}`)
}
