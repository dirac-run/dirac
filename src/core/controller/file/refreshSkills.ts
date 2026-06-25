import { RefreshedSkills, SkillInfo } from "@shared/proto/dirac/file"
import { parseYamlFrontmatter } from "@utils/frontmatter"
import { Logger } from "@/shared/services/Logger"
import fs from "fs/promises"
import path from "path"
import { getSkillsDirectoriesForScan } from "@/core/storage/disk"
import { HostProvider } from "@/hosts/host-provider"
import { fileExistsAtPath, isDirectory } from "@/utils/fs"
import { Controller } from ".."
import { BUILTIN_SKILLS } from "@core/context/instructions/user-instructions/skills"

/**
 * Scan a directory for skill subdirectories containing SKILL.md files.
 */
async function scanSkillsDirectory(dirPath: string): Promise<SkillInfo[]> {
	const skills: SkillInfo[] = []

	if (!(await fileExistsAtPath(dirPath)) || !(await isDirectory(dirPath))) {
		return skills
	}

	try {
		const entries = await fs.readdir(dirPath)

		for (const entryName of entries) {
			const entryPath = path.join(dirPath, entryName)
			const stats = await fs.stat(entryPath).catch(() => null)
			if (!stats?.isDirectory()) continue

			const skillMdPath = path.join(entryPath, "SKILL.md")
			// Resolve symlinks so the same physical skill isn't listed twice
			const resolvedPath = await fs.realpath(skillMdPath).catch(() => skillMdPath)

			try {
				const fileContent = await fs.readFile(skillMdPath, "utf-8")
				const { data: frontmatter, parseError } = parseYamlFrontmatter(fileContent)

				if (parseError) {
					Logger.warn(`Failed to parse YAML frontmatter for skill at ${entryPath}: ${parseError}`)
					continue
				}

				// Validate required fields
				if (!frontmatter.name || typeof frontmatter.name !== "string") {
					Logger.warn(`Skill at ${entryPath} missing required 'name' field in frontmatter`)
					continue
				}
				if (!frontmatter.description || typeof frontmatter.description !== "string") {
					Logger.warn(`Skill at ${entryPath} missing required 'description' field in frontmatter`)
					continue
				}
				if (frontmatter.name !== entryName) {
					Logger.warn(
						`Skill name "${frontmatter.name}" in frontmatter doesn't match directory name "${entryName}" at ${entryPath}`,
					)
					continue
				}

				skills.push(
					SkillInfo.create({
						name: entryName,
						description: frontmatter.description,
						path: resolvedPath,
						enabled: true, // Will be updated with toggle state
					}),
				)
			} catch (error) {
				Logger.warn(`Failed to load skill at ${entryPath}:`, error)
			}
		}
	} catch {
		// Directory read error, skip
	}

	return skills
}

/**
 * Refreshes all skill toggles (discovers skills and their enabled state)
 */
export async function refreshSkills(controller: Controller): Promise<RefreshedSkills> {
	// Get workspace paths for local skills
	const workspacePaths = await HostProvider.workspace.getWorkspacePaths({})
	const allWorkspacePaths = workspacePaths.paths

	const globalSkillsMap = new Map<string, SkillInfo>()
	const localSkillsMap = new Map<string, SkillInfo>()

	// 1. Scan global directories (only once)
	// We use an empty string as cwd to get global directories from getSkillsDirectoriesForScan
	const scanDirsForGlobal = getSkillsDirectoriesForScan("")
	for (const dir of scanDirsForGlobal) {
		if (dir.source === "global") {
			const skills = await scanSkillsDirectory(dir.path)
			for (const skill of skills) {
				if (!globalSkillsMap.has(skill.path)) {
					globalSkillsMap.set(skill.path, skill)
				}
			}
		}
	}

	// Add built-in skills that ship with the product
	for (const builtinSkill of BUILTIN_SKILLS) {
		if (!globalSkillsMap.has(builtinSkill.path)) {
			globalSkillsMap.set(
				builtinSkill.path,
				SkillInfo.create({
					name: builtinSkill.name,
					description: builtinSkill.description,
					path: builtinSkill.path,
					enabled: true,
				}),
			)
		}
	}

	// 2. Scan all workspace folders for project skills
	for (const workspacePath of allWorkspacePaths) {
		const scanDirs = getSkillsDirectoriesForScan(workspacePath)
		for (const dir of scanDirs) {
			if (dir.source === "project") {
				const skills = await scanSkillsDirectory(dir.path)
				for (const skill of skills) {
					if (!localSkillsMap.has(skill.path)) {
						localSkillsMap.set(skill.path, skill)
					}
				}
			}
		}
	}

	const globalSkills = Array.from(globalSkillsMap.values())
	const localSkills = Array.from(localSkillsMap.values())

	// Get global toggles and apply them
	const globalToggles = controller.stateManager.getGlobalSettingsKey("globalSkillsToggles") || {}
	for (const skill of globalSkills) {
		skill.enabled = globalToggles[skill.path] !== false
	}

	// Get local toggles and apply them
	const localToggles = controller.stateManager.getWorkspaceStateKey("localSkillsToggles") || {}
	for (const skill of localSkills) {
		skill.enabled = localToggles[skill.path] !== false
	}

	return RefreshedSkills.create({
		globalSkills,
		localSkills,
	})
}
