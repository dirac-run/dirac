import { getSkillsDirectoriesForScan } from "@core/storage/disk"
import type { SkillContent, SkillMetadata } from "@shared/skills"
import { fileExistsAtPath, isDirectory } from "@utils/fs"
import * as fs from "fs/promises"
import * as path from "path"
import { Logger } from "@/shared/services/Logger"
import { parseYamlFrontmatter } from "@utils/frontmatter"

/**
 * Built-in skills that ship with the product.
 * Content is embedded here because .md files are not copied by the build system.
 * The canonical source of truth is src/core/prompts/skills/<name>/SKILL.md.
 */
const NEW_TOOL_SKILL_INSTRUCTIONS = `
# Creating a New Custom Tool

You are helping the user create a new custom tool for Dirac. Guide them through an interactive process to define and create a tool.

## Step 1: Gather Requirements

Ask the user these questions (all at once if they gave a detailed request, otherwise one at a time):

1. **Tool name** — a \`snake_case\` identifier (e.g. \`run_tests\`, \`format_code\`, \`analyze_deps\`).
2. **Description** — what the tool does, shown to the LLM.
3. **Parameters** — for each input the tool needs:
   - Name (\`snake_case\`)
   - Type (\`string\` | \`boolean\` | \`integer\` | \`array\` | \`object\`)
   - Required or optional
   - Instruction text for the LLM
4. **Scope** — where should the tool live?
   - **Global** (\`~/.dirac/tools/\`): available in every workspace
   - **Workspace** (\`<workspace>/.dirac/tools/\`): available only in this project
   - **Task** (\`<task storage>/tools/\`): available only for this task, survives task resume
5. **Requirements** — any specific behavior, logic, edge cases, or env traits the tool should use.

## Step 2: Create the Tool with \`upsert_tool\`

Call the \`upsert_tool\` tool with the gathered information. It handles code generation, compilation, validation, and smoke testing internally.

Parameters:
- \`tools\`: array of tool definitions, each containing:
  - \`name\`: the snake_case tool identifier
  - \`scope\`: \`"global"\`, \`"workspace"\`, or \`"task"\`
  - \`description\`: what the tool does
  - \`parameters\`: array of \`{ name, type, required, instruction }\`
  - \`requirements\`: natural language description of what the tool should do

## Step 3: Handle Results

- **Success** (\`✅\`): proceed to Step 4.
- **Failure** (\`❌\`): read the error, adjust requirements, and call \`upsert_tool\` again. Max 3 retries.

## Step 4: Inform the User

Tell the user:
- The tool will appear in the **Tools** tab of the settings panel.
- User tools default to **disabled** and must be enabled in settings before use.
- Once enabled, the tool is available to the main agent and to subagents whose allowlist includes the tool id/name.
- Task-scoped tools are automatically available for this task and will persist across task resume.
`

const DELETE_TOOL_SKILL_INSTRUCTIONS = `
# Deleting a User-Defined Custom Tool

You are helping the user delete a custom tool that was previously created with the \`/new-tool\` command. Only user-defined tools (global or workspace scope) can be deleted — built-in tools are protected and cannot be removed.

## Step 1: Discover User Tools

Scan both tool directories for user-created tools:

1. **Global tools** — \`~/.dirac/tools/\` (or \`$DIRAC_DIR/tools/\` if \`DIRAC_DIR\` is set)
2. **Workspace tools** — \`<workspace>/.dirac/tools/\`

Use \`list_files\` to enumerate subdirectories, then \`read_file\` each \`dirac-tool.json\` manifest to collect tool metadata (id, name, scope, entry).

Also read the \`spec\` from \`tool.ts\` to get the tool's description.

If no user tools are found in either location, inform the user that there are no user-defined tools to delete and stop.

## Step 2: Present the Tool List

Present the discovered tools to the user grouped by scope. For each tool show:
- **id** (from manifest)
- **name** (from manifest)
- **description** (from tool.ts spec)
- **scope** (global or workspace)
- **path** (filesystem location of the tool directory)

Format the list clearly, for example:

\`\`\`
**Global tools** (~/.dirac/tools/):
  1. analyze_deps — Analyze project dependencies
  2. format_code — Auto-format source files

**Workspace tools** (<workspace>/.dirac/tools/):
  3. run_tests — Run the project test command
\`\`\`

Use \`ask_followup_question\` to let the user select which tool(s) to delete. Include a "Cancel — don't delete anything" option.

## Step 3: Confirm Deletion

After the user selects one or more tools, confirm the deletion explicitly:

> You are about to permanently delete the following tool(s):
> - \`run_tests\` from \`<workspace>/.dirac/tools/run_tests/\`
>
> This will remove the tool directory and all its files. This action cannot be undone.
> The tool will no longer load in new sessions.
>
> Proceed?

Use \`ask_followup_question\` with "Yes, delete" and "No, cancel" options.

## Step 4: Delete the Tool

For each confirmed tool, delete its entire directory using \`execute_command\`:

\`\`\`bash
rm -rf <tool-directory-path>
\`\`\`

Also clean up any compiled cache files at \`~/.dirac/cache/tools/<tool_id>-*.mjs\` if they exist:

\`\`\`bash
rm -f ~/.dirac/cache/tools/<tool_id>-*.mjs
\`\`\`

If a deletion fails (e.g., permission error), report the error to the user but continue with remaining deletions.

## Step 5: Inform the User

After successful deletion, tell the user:

- The tool directory has been permanently removed.
- The tool will no longer load in new sessions (the tool registry re-scans directories at workspace initialization).
- If the tool was currently enabled, it may still appear in the current session's tool list until the session is restarted.
- If they want to remove the tool's toggle state from settings, they can do so in the **Tools** tab of the settings panel.
`

const BUILTIN_SKILL_CONTENT = new Map<string, string>([
	["<builtin>/new-tool/SKILL.md", NEW_TOOL_SKILL_INSTRUCTIONS],
	["<builtin>/delete-tool/SKILL.md", DELETE_TOOL_SKILL_INSTRUCTIONS],
])

export const BUILTIN_SKILLS: SkillMetadata[] = [
	{
		name: "new-tool",
		description: "Create a new custom tool for Dirac through an interactive interview",
		path: "<builtin>/new-tool/SKILL.md",
		source: "global",
		interactiveOnly: true,
	},
	{
		name: "delete-tool",
		description: "Delete a local user-defined custom tool from global or workspace scope",
		path: "<builtin>/delete-tool/SKILL.md",
		source: "global",
		interactiveOnly: true,
	},
]

/**
 * Scan a directory for skill subdirectories containing SKILL.md files.
 */
async function scanSkillsDirectory(dirPath: string, source: "global" | "project"): Promise<SkillMetadata[]> {
	const skills: SkillMetadata[] = []

	if (!(await fileExistsAtPath(dirPath)) || !(await isDirectory(dirPath))) {
		return skills
	}

	try {
		const entries = await fs.readdir(dirPath)

		for (const entryName of entries) {
			const entryPath = path.join(dirPath, entryName)
			const stats = await fs.stat(entryPath).catch(() => null)
			if (!stats?.isDirectory()) continue

			const skill = await loadSkillMetadata(entryPath, source, entryName)
			if (skill) {
				skills.push(skill)
			}
		}
	} catch (error: unknown) {
		if (error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "EACCES") {
			Logger.warn(`Permission denied reading skills directory: ${dirPath}`)
		}
	}

	return skills
}

/**
 * Load skill metadata from a skill directory.
 */
async function loadSkillMetadata(
	skillDir: string,
	source: "global" | "project",
	skillName: string,
): Promise<SkillMetadata | null> {
	const skillMdPath = path.join(skillDir, "SKILL.md")
	// Resolve symlinks so the same physical skill isn't listed twice
	const resolvedPath = await fs.realpath(skillMdPath).catch(() => skillMdPath)
	if (!(await fileExistsAtPath(skillMdPath))) return null

	try {
		const fileContent = await fs.readFile(skillMdPath, "utf-8")
		const { data: frontmatter, parseError } = parseYamlFrontmatter(fileContent)

		if (parseError) {
			Logger.warn(`Failed to parse YAML frontmatter for skill at ${skillDir}: ${parseError}`)
			return null
		}

		// Validate required fields
		if (!frontmatter.name || typeof frontmatter.name !== "string") {
			Logger.warn(`Skill at ${skillDir} missing required 'name' field in frontmatter`)
			return null
		}
		if (!frontmatter.description || typeof frontmatter.description !== "string") {
			Logger.warn(`Skill at ${skillDir} missing required 'description' field in frontmatter`)
			return null
		}

		// Name must match directory name per spec
		if (frontmatter.name !== skillName) {
			Logger.warn(`Skill name "${frontmatter.name}" in frontmatter doesn't match directory "${skillName}" at ${skillDir}`)
			return null
		}

		return {
			name: skillName,
			description: frontmatter.description,
			path: resolvedPath,
			source,
		}
	} catch (error) {
		Logger.warn(`Failed to load skill at ${skillDir}:`, error)
		return null
	}
}

/**
 * Discover all skills from global (~/.dirac/skills) and project directories.
 * Returns skills in order: project skills first, then global skills.
 * Global skills take precedence over project skills with the same name.
 */
export async function discoverSkills(cwd: string): Promise<SkillMetadata[]> {
	const skills: SkillMetadata[] = []

	const scanDirs = getSkillsDirectoriesForScan(cwd)

	for (const dir of scanDirs) {
		const dirSkills = await scanSkillsDirectory(dir.path, dir.source)
		skills.push(...dirSkills)
	}

	// Append built-in skills that ship with the product
	skills.push(...BUILTIN_SKILLS)

	return skills
}

/**
 * Get available skills with override resolution (global > project).
 */
export function getAvailableSkills(skills: SkillMetadata[]): SkillMetadata[] {
	const seen = new Set<string>()
	const result: SkillMetadata[] = []

	// Iterate backwards: global skills (added last) are seen first and take precedence
	for (let i = skills.length - 1; i >= 0; i--) {
		const skill = skills[i]
		if (!seen.has(skill.name)) {
			seen.add(skill.name)
			result.unshift(skill)
		}
	}

	return result
}

/**
 * Get full skill content including instructions.
 */
/**
 * List supporting files (docs and scripts) in a skill directory.
 */
export async function listSupportingFiles(skillMdPath: string): Promise<{ docs: string[]; scripts: string[] }> {
	const skillDir = path.dirname(skillMdPath)
	const docsDir = path.join(skillDir, "docs")
	const scriptsDir = path.join(skillDir, "scripts")

	const docs: string[] = []
	const scripts: string[] = []

	try {
		if (await fileExistsAtPath(docsDir)) {
			const files = await fs.readdir(docsDir)
			docs.push(...files.filter((f) => f.endsWith(".md") || f.endsWith(".txt")))
		}
	} catch (error) {
		Logger.warn(`Failed to read docs directory for skill at ${skillDir}:`, error)
	}

	try {
		if (await fileExistsAtPath(scriptsDir)) {
			const files = await fs.readdir(scriptsDir)
			scripts.push(...files.filter((f) => !f.startsWith(".")))
		}
	} catch (error) {
		Logger.warn(`Failed to read scripts directory for skill at ${skillDir}:`, error)
	}

	return { docs, scripts }
}

export async function getSkillContent(skillName: string, availableSkills: SkillMetadata[]): Promise<SkillContent | null> {
	const skill = availableSkills.find((s) => s.name === skillName)
	if (!skill) return null

	// Check built-in skills first (embedded content, no filesystem read needed)
	const builtinContent = BUILTIN_SKILL_CONTENT.get(skill.path)
	if (builtinContent) {
		return {
			...skill,
			instructions: builtinContent.trim(),
		}
	}

	try {
		const fileContent = await fs.readFile(skill.path, "utf-8")
		const { body } = parseYamlFrontmatter(fileContent)

		return {
			...skill,
			instructions: body.trim(),
		}
	} catch {
		return null
	}
}

/**
 * Get skills from cache or discover them from disk if not already cached.
 * This ensures we only scan the file system once per task.
 */
export async function getOrDiscoverSkills(
	cwd: string,
	cacheProvider: { discoveredSkillsCache?: SkillMetadata[] },
): Promise<SkillMetadata[]> {
	if (cacheProvider.discoveredSkillsCache !== undefined) {
		return cacheProvider.discoveredSkillsCache
	}

	const allSkills = await discoverSkills(cwd)
	const resolvedSkills = getAvailableSkills(allSkills)
	cacheProvider.discoveredSkillsCache = resolvedSkills
	return resolvedSkills
}
