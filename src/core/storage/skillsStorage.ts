import fs from "fs/promises"
import os from "os"
import * as path from "path"
import { GlobalFileNames } from "./fileNames"
import { getDiracHomePath } from "./paths"

export type SkillsScanDirectory = {
	path: string
	source: "project" | "global"
}

// Returns the global Dirac skills directory path (~/.dirac/skills) without creating it.
function getDiracSkillsDirectoryPath(): string {
	return path.join(getDiracHomePath(), "skills")
}

// Returns the global agent skills directory path (~/.agents/skills) without creating it.
function getAgentSkillsDirectoryPath(): string {
	return path.join(os.homedir(), ".agents", "skills")
}

// Returns the global Claude skills directory path (~/.claude/skills) without creating it.
function getClaudeSkillsDirectoryPath(): string {
	return path.join(os.homedir(), ".claude", "skills")
}

// Returns the global AI skills directory path (~/.ai/skills) without creating it.
function getAiSkillsDirectoryPath(): string {
	return path.join(os.homedir(), ".ai", "skills")
}

// Ensures the agent skills directory exists (global or workspace-scoped) and returns its path.
export async function ensureAgentSkillsDirectoryExists(options: { isGlobal: boolean; workspacePath?: string }): Promise<string> {
	const agentSkillsDir = options.isGlobal
		? getAgentSkillsDirectoryPath()
		: path.join(options.workspacePath ?? "", GlobalFileNames.agentsSkillsDir)
	try {
		await fs.mkdir(agentSkillsDir, { recursive: true })
	} catch (_error) {
		return agentSkillsDir
	}
	return agentSkillsDir
}

// Returns the list of skills directories to scan without creating them. Project dirs first, then global.
export function getSkillsDirectoriesForScan(cwd: string): SkillsScanDirectory[] {
	return [
		{ path: path.join(cwd, GlobalFileNames.diracruleSkillsDir), source: "project" },
		{ path: path.join(cwd, GlobalFileNames.diracSkillsDir), source: "project" },
		{ path: path.join(cwd, GlobalFileNames.claudeSkillsDir), source: "project" },
		{ path: path.join(cwd, GlobalFileNames.aiSkillsDir), source: "project" },
		{ path: path.join(cwd, GlobalFileNames.agentsSkillsDir), source: "project" },
		{ path: getDiracSkillsDirectoryPath(), source: "global" },
		{ path: getAgentSkillsDirectoryPath(), source: "global" },
		{ path: getClaudeSkillsDirectoryPath(), source: "global" },
		{ path: getAiSkillsDirectoryPath(), source: "global" },
	]
}
