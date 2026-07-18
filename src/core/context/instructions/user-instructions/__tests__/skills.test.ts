/**
 * Unit tests for skills utility functions
 * Tests skill discovery, override resolution, toggle filtering, and content loading
 */

import { expect } from "chai"
import * as fs from "fs"
import { afterEach, beforeEach, describe, it } from "mocha"
import * as path from "path"
import * as sinon from "sinon"

import * as disk from "@/core/storage/disk"
import { Logger } from "@/shared/services/Logger"
import * as fsUtils from "@/utils/fs"
import { discoverSkills, getAvailableSkills, getSkillContent } from "../skills"

/** Filter out built-in skills (new-tool, delete-tool) that are appended by discoverSkills */
const filterBuiltin = (skills: { path: string; name?: string; description?: string; source?: string }[]) =>
	skills.filter((s) => !s.path.startsWith("<builtin>"))

describe("Skills Utility Functions", () => {
	let sandbox: sinon.SinonSandbox
	let fileExistsStub: sinon.SinonStub
	let isDirectoryStub: sinon.SinonStub
	let readdirStub: sinon.SinonStub
	let statStub: sinon.SinonStub
	let readFileStub: sinon.SinonStub

	// Use path.join for OS-independent paths
	const TEST_CWD = path.join("/test", "project")
	const GLOBAL_SKILLS_DIR = path.join("/home", "user", ".dirac", "skills")

	beforeEach(() => {
		sandbox = sinon.createSandbox()

		// Stub Logger.warn to avoid noise in test output
		sandbox.stub(Logger, "warn")

		// Stub filesystem utilities
		fileExistsStub = sandbox.stub(fsUtils, "fileExistsAtPath")
		isDirectoryStub = sandbox.stub(fsUtils, "isDirectory")
		readdirStub = sandbox.stub(fs.promises, "readdir")
		statStub = sandbox.stub(fs.promises, "stat")
		readFileStub = sandbox.stub(fs.promises, "readFile")
		sandbox.stub(disk, "getSkillsDirectoriesForScan").returns([
			{ path: path.join(TEST_CWD, ".diracrules", "skills"), source: "project" },
			{ path: path.join(TEST_CWD, ".dirac", "skills"), source: "project" },
			{ path: path.join(TEST_CWD, ".claude", "skills"), source: "project" },
			{ path: path.join(TEST_CWD, ".agents", "skills"), source: "project" },
			{ path: GLOBAL_SKILLS_DIR, source: "global" },
			{ path: path.join("/home", "user", ".agents", "skills"), source: "global" },
		])

		// Default: no directories exist
		fileExistsStub.resolves(false)
		isDirectoryStub.resolves(false)
	})

	afterEach(() => {
		sandbox.restore()
	})

	describe("discoverSkills", () => {
		it("should discover skills from global directory", async () => {
			const skillDir = path.join(GLOBAL_SKILLS_DIR, "my-skill")
			const skillMdPath = path.join(skillDir, "SKILL.md")

			fileExistsStub.withArgs(GLOBAL_SKILLS_DIR).resolves(true)
			fileExistsStub.withArgs(skillMdPath).resolves(true)
			isDirectoryStub.withArgs(GLOBAL_SKILLS_DIR).resolves(true)
			readdirStub.withArgs(GLOBAL_SKILLS_DIR).resolves(["my-skill"])
			statStub.withArgs(skillDir).resolves({ isDirectory: () => true })
			readFileStub.withArgs(skillMdPath, "utf-8").resolves(`---
name: my-skill
description: A test skill
---
Instructions here`)

			const skills = await discoverSkills(TEST_CWD)

			expect(filterBuiltin(skills)).to.have.lengthOf(1)
			expect(filterBuiltin(skills)[0].name).to.equal("my-skill")
			expect(filterBuiltin(skills)[0].description).to.equal("A test skill")
			expect(filterBuiltin(skills)[0].source).to.equal("global")
		})

		it("should discover skills from project .diracrules/skills directory", async () => {
			const projectSkillsDir = path.join(TEST_CWD, ".diracrules", "skills")
			const skillDir = path.join(projectSkillsDir, "explaining-code")
			const skillMdPath = path.join(skillDir, "SKILL.md")

			fileExistsStub.withArgs(projectSkillsDir).resolves(true)
			fileExistsStub.withArgs(skillMdPath).resolves(true)
			isDirectoryStub.withArgs(projectSkillsDir).resolves(true)
			readdirStub.withArgs(projectSkillsDir).resolves(["explaining-code"])
			statStub.withArgs(skillDir).resolves({ isDirectory: () => true })
			readFileStub.withArgs(skillMdPath, "utf-8").resolves(`---
name: explaining-code
description: Explains code with diagrams and analogies
---
Use analogies and ASCII diagrams when explaining code.`)

			const skills = await discoverSkills(TEST_CWD)

			expect(filterBuiltin(skills)).to.have.lengthOf(1)
			expect(filterBuiltin(skills)[0].name).to.equal("explaining-code")
			expect(filterBuiltin(skills)[0].source).to.equal("project")
		})

		it("should discover skills from project .dirac/skills directory", async () => {
			const diracSkillsDir = path.join(TEST_CWD, ".dirac", "skills")
			const skillDir = path.join(diracSkillsDir, "debugging")
			const skillMdPath = path.join(skillDir, "SKILL.md")

			fileExistsStub.withArgs(diracSkillsDir).resolves(true)
			fileExistsStub.withArgs(skillMdPath).resolves(true)
			isDirectoryStub.withArgs(diracSkillsDir).resolves(true)
			readdirStub.withArgs(diracSkillsDir).resolves(["debugging"])
			statStub.withArgs(skillDir).resolves({ isDirectory: () => true })
			readFileStub.withArgs(skillMdPath, "utf-8").resolves(`---
name: debugging
description: Debug code systematically
---
Use systematic debugging approaches.`)

			const skills = await discoverSkills(TEST_CWD)

			expect(filterBuiltin(skills)).to.have.lengthOf(1)
			expect(filterBuiltin(skills)[0].name).to.equal("debugging")
			expect(filterBuiltin(skills)[0].source).to.equal("project")
		})

		it("should discover skills from project .claude/skills directory", async () => {
			const claudeSkillsDir = path.join(TEST_CWD, ".claude", "skills")
			const skillDir = path.join(claudeSkillsDir, "coding")
			const skillMdPath = path.join(skillDir, "SKILL.md")

			fileExistsStub.withArgs(claudeSkillsDir).resolves(true)
			fileExistsStub.withArgs(skillMdPath).resolves(true)
			isDirectoryStub.withArgs(claudeSkillsDir).resolves(true)
			readdirStub.withArgs(claudeSkillsDir).resolves(["coding"])
			statStub.withArgs(skillDir).resolves({ isDirectory: () => true })
			readFileStub.withArgs(skillMdPath, "utf-8").resolves(`---
name: coding
description: Write clean code
---
Follow best practices.`)

			const skills = await discoverSkills(TEST_CWD)

			expect(filterBuiltin(skills)).to.have.lengthOf(1)
			expect(filterBuiltin(skills)[0].name).to.equal("coding")
			expect(filterBuiltin(skills)[0].source).to.equal("project")
		})

		it("should discover skills from project .agents/skills directory", async () => {
			const agentsSkillsDir = path.join(TEST_CWD, ".agents", "skills")
			const skillDir = path.join(agentsSkillsDir, "testing")
			const skillMdPath = path.join(skillDir, "SKILL.md")

			fileExistsStub.withArgs(agentsSkillsDir).resolves(true)
			fileExistsStub.withArgs(skillMdPath).resolves(true)
			isDirectoryStub.withArgs(agentsSkillsDir).resolves(true)
			readdirStub.withArgs(agentsSkillsDir).resolves(["testing"])
			statStub.withArgs(skillDir).resolves({ isDirectory: () => true })
			readFileStub.withArgs(skillMdPath, "utf-8").resolves(`---
name: testing
description: Write comprehensive tests
---
Always write tests.`)

			const skills = await discoverSkills(TEST_CWD)

			expect(filterBuiltin(skills)).to.have.lengthOf(1)
			expect(filterBuiltin(skills)[0].name).to.equal("testing")
			expect(filterBuiltin(skills)[0].source).to.equal("project")
		})

		it("should handle empty skills directories gracefully", async () => {
			fileExistsStub.withArgs(GLOBAL_SKILLS_DIR).resolves(true)
			isDirectoryStub.withArgs(GLOBAL_SKILLS_DIR).resolves(true)
			readdirStub.withArgs(GLOBAL_SKILLS_DIR).resolves([])

			const skills = await discoverSkills(TEST_CWD)

			expect(filterBuiltin(skills)).to.have.lengthOf(0)
		})

		it("should skip non-directory entries in skills folder", async () => {
			const readmePath = path.join(GLOBAL_SKILLS_DIR, "README.md")
			const skillDir = path.join(GLOBAL_SKILLS_DIR, "my-skill")
			const skillMdPath = path.join(skillDir, "SKILL.md")

			fileExistsStub.withArgs(GLOBAL_SKILLS_DIR).resolves(true)
			isDirectoryStub.withArgs(GLOBAL_SKILLS_DIR).resolves(true)
			readdirStub.withArgs(GLOBAL_SKILLS_DIR).resolves(["README.md", "my-skill"])
			statStub.withArgs(readmePath).resolves({ isDirectory: () => false })
			statStub.withArgs(skillDir).resolves({ isDirectory: () => true })
			fileExistsStub.withArgs(skillMdPath).resolves(true)
			readFileStub.withArgs(skillMdPath, "utf-8").resolves(`---
name: my-skill
description: A skill
---
Content`)

			const skills = await discoverSkills(TEST_CWD)

			expect(filterBuiltin(skills)).to.have.lengthOf(1)
			expect(filterBuiltin(skills)[0].name).to.equal("my-skill")
		})

		it("should skip skill directories without SKILL.md", async () => {
			const skillDir = path.join(GLOBAL_SKILLS_DIR, "incomplete-skill")
			const skillMdPath = path.join(skillDir, "SKILL.md")

			fileExistsStub.withArgs(GLOBAL_SKILLS_DIR).resolves(true)
			isDirectoryStub.withArgs(GLOBAL_SKILLS_DIR).resolves(true)
			readdirStub.withArgs(GLOBAL_SKILLS_DIR).resolves(["incomplete-skill"])
			statStub.withArgs(skillDir).resolves({ isDirectory: () => true })
			fileExistsStub.withArgs(skillMdPath).resolves(false)

			const skills = await discoverSkills(TEST_CWD)

			expect(filterBuiltin(skills)).to.have.lengthOf(0)
		})
	})

	describe("getAvailableSkills - Override Resolution", () => {
		it("should override project skill with global skill of same name", async () => {
			const globalSkillDir = path.join(GLOBAL_SKILLS_DIR, "coding")
			const globalSkillMdPath = path.join(globalSkillDir, "SKILL.md")

			// Setup global skill (higher priority)
			fileExistsStub.withArgs(GLOBAL_SKILLS_DIR).resolves(true)
			fileExistsStub.withArgs(globalSkillMdPath).resolves(true)
			isDirectoryStub.withArgs(GLOBAL_SKILLS_DIR).resolves(true)
			readdirStub.withArgs(GLOBAL_SKILLS_DIR).resolves(["coding"])
			statStub.withArgs(globalSkillDir).resolves({ isDirectory: () => true })
			readFileStub.withArgs(globalSkillMdPath, "utf-8").resolves(`---
name: coding
description: Global coding skill
---
Global instructions`)

			// Setup project skill with same name (lower priority)
			const projectSkillsDir = path.join(TEST_CWD, ".diracrules", "skills")
			const projectSkillDir = path.join(projectSkillsDir, "coding")
			const projectSkillMdPath = path.join(projectSkillDir, "SKILL.md")

			fileExistsStub.withArgs(projectSkillsDir).resolves(true)
			fileExistsStub.withArgs(projectSkillMdPath).resolves(true)
			isDirectoryStub.withArgs(projectSkillsDir).resolves(true)
			readdirStub.withArgs(projectSkillsDir).resolves(["coding"])
			statStub.withArgs(projectSkillDir).resolves({ isDirectory: () => true })
			readFileStub.withArgs(projectSkillMdPath, "utf-8").resolves(`---
name: coding
description: Project coding skill
---
Project instructions`)

			const allSkills = await discoverSkills(TEST_CWD)
			const skills = getAvailableSkills(allSkills)

			expect(filterBuiltin(skills)).to.have.lengthOf(1)
			expect(filterBuiltin(skills)[0].description).to.equal("Global coding skill")
			expect(filterBuiltin(skills)[0].source).to.equal("global")
		})

		it("should keep both skills when names are different", async () => {
			const globalSkillDir = path.join(GLOBAL_SKILLS_DIR, "global-skill")
			const globalSkillMdPath = path.join(globalSkillDir, "SKILL.md")

			// Setup global skill
			fileExistsStub.withArgs(GLOBAL_SKILLS_DIR).resolves(true)
			fileExistsStub.withArgs(globalSkillMdPath).resolves(true)
			isDirectoryStub.withArgs(GLOBAL_SKILLS_DIR).resolves(true)
			readdirStub.withArgs(GLOBAL_SKILLS_DIR).resolves(["global-skill"])
			statStub.withArgs(globalSkillDir).resolves({ isDirectory: () => true })
			readFileStub.withArgs(globalSkillMdPath, "utf-8").resolves(`---
name: global-skill
description: A global skill
---
Content`)

			// Setup project skill with different name
			const projectSkillsDir = path.join(TEST_CWD, ".diracrules", "skills")
			const projectSkillDir = path.join(projectSkillsDir, "project-skill")
			const projectSkillMdPath = path.join(projectSkillDir, "SKILL.md")

			fileExistsStub.withArgs(projectSkillsDir).resolves(true)
			fileExistsStub.withArgs(projectSkillMdPath).resolves(true)
			isDirectoryStub.withArgs(projectSkillsDir).resolves(true)
			readdirStub.withArgs(projectSkillsDir).resolves(["project-skill"])
			statStub.withArgs(projectSkillDir).resolves({ isDirectory: () => true })
			readFileStub.withArgs(projectSkillMdPath, "utf-8").resolves(`---
name: project-skill
description: A project skill
---
Content`)

			const allSkills = await discoverSkills(TEST_CWD)
			const skills = getAvailableSkills(allSkills)

			expect(filterBuiltin(skills)).to.have.lengthOf(2)
			const names = skills.map((s) => s.name)
			expect(names).to.include("global-skill")
			expect(names).to.include("project-skill")
		})

		it("prevents disk skills from shadowing trusted built-in skills", () => {
			const skills = getAvailableSkills([
				{
					name: "new-tool",
					description: "Untrusted project shadow",
					path: "/project/new-tool/SKILL.md",
					source: "project",
				},
				{
					name: "new-tool",
					description: "Trusted built-in",
					path: "<builtin>/new-tool/SKILL.md",
					source: "builtin",
					toolDependencies: ["upsert_tool"],
				},
			])

			expect(skills).to.have.lengthOf(1)
			expect(skills[0].source).to.equal("builtin")
			expect(skills[0].toolDependencies).to.deep.equal(["upsert_tool"])
		})

	})

	describe("Metadata Validation", () => {
		it("should reject skill with missing name field", async () => {
			const skillDir = path.join(GLOBAL_SKILLS_DIR, "bad-skill")
			const skillMdPath = path.join(skillDir, "SKILL.md")

			fileExistsStub.withArgs(GLOBAL_SKILLS_DIR).resolves(true)
			fileExistsStub.withArgs(skillMdPath).resolves(true)
			isDirectoryStub.withArgs(GLOBAL_SKILLS_DIR).resolves(true)
			readdirStub.withArgs(GLOBAL_SKILLS_DIR).resolves(["bad-skill"])
			statStub.withArgs(skillDir).resolves({ isDirectory: () => true })
			readFileStub.withArgs(skillMdPath, "utf-8").resolves(`---
description: Missing name
---
Content`)

			const skills = await discoverSkills(TEST_CWD)

			expect(filterBuiltin(skills)).to.have.lengthOf(0)
			sinon.assert.calledWithMatch(Logger.warn as sinon.SinonStub, /missing required 'name' field/)
		})

		it("should reject skill with missing description field", async () => {
			const skillDir = path.join(GLOBAL_SKILLS_DIR, "bad-skill")
			const skillMdPath = path.join(skillDir, "SKILL.md")

			fileExistsStub.withArgs(GLOBAL_SKILLS_DIR).resolves(true)
			fileExistsStub.withArgs(skillMdPath).resolves(true)
			isDirectoryStub.withArgs(GLOBAL_SKILLS_DIR).resolves(true)
			readdirStub.withArgs(GLOBAL_SKILLS_DIR).resolves(["bad-skill"])
			statStub.withArgs(skillDir).resolves({ isDirectory: () => true })
			readFileStub.withArgs(skillMdPath, "utf-8").resolves(`---
name: bad-skill
---
Content`)

			const skills = await discoverSkills(TEST_CWD)

			expect(filterBuiltin(skills)).to.have.lengthOf(0)
			sinon.assert.calledWithMatch(Logger.warn as sinon.SinonStub, /missing required 'description' field/)
		})

		it("should reject skill when name doesn't match directory name", async () => {
			const skillDir = path.join(GLOBAL_SKILLS_DIR, "my-dir")
			const skillMdPath = path.join(skillDir, "SKILL.md")

			fileExistsStub.withArgs(GLOBAL_SKILLS_DIR).resolves(true)
			fileExistsStub.withArgs(skillMdPath).resolves(true)
			isDirectoryStub.withArgs(GLOBAL_SKILLS_DIR).resolves(true)
			readdirStub.withArgs(GLOBAL_SKILLS_DIR).resolves(["my-dir"])
			statStub.withArgs(skillDir).resolves({ isDirectory: () => true })
			readFileStub.withArgs(skillMdPath, "utf-8").resolves(`---
name: different-name
description: Mismatched name
---
Content`)

			const skills = await discoverSkills(TEST_CWD)

			expect(filterBuiltin(skills)).to.have.lengthOf(0)
			sinon.assert.calledWithMatch(Logger.warn as sinon.SinonStub, /doesn't match directory/)
		})

		it("should handle malformed YAML frontmatter gracefully", async () => {
			const skillDir = path.join(GLOBAL_SKILLS_DIR, "bad-yaml")
			const skillMdPath = path.join(skillDir, "SKILL.md")

			fileExistsStub.withArgs(GLOBAL_SKILLS_DIR).resolves(true)
			fileExistsStub.withArgs(skillMdPath).resolves(true)
			isDirectoryStub.withArgs(GLOBAL_SKILLS_DIR).resolves(true)
			readdirStub.withArgs(GLOBAL_SKILLS_DIR).resolves(["bad-yaml"])
			statStub.withArgs(skillDir).resolves({ isDirectory: () => true })
			readFileStub.withArgs(skillMdPath, "utf-8").resolves(`---
name: [invalid yaml
description: broken
---
Content`)

			const skills = await discoverSkills(TEST_CWD)

			expect(filterBuiltin(skills)).to.have.lengthOf(0)
		})

		it("should handle file without frontmatter", async () => {
			const skillDir = path.join(GLOBAL_SKILLS_DIR, "no-front")
			const skillMdPath = path.join(skillDir, "SKILL.md")

			fileExistsStub.withArgs(GLOBAL_SKILLS_DIR).resolves(true)
			fileExistsStub.withArgs(skillMdPath).resolves(true)
			isDirectoryStub.withArgs(GLOBAL_SKILLS_DIR).resolves(true)
			readdirStub.withArgs(GLOBAL_SKILLS_DIR).resolves(["no-front"])
			statStub.withArgs(skillDir).resolves({ isDirectory: () => true })
			readFileStub.withArgs(skillMdPath, "utf-8").resolves(`Just plain markdown content without frontmatter`)

			const skills = await discoverSkills(TEST_CWD)

			expect(filterBuiltin(skills)).to.have.lengthOf(0)
		})
	})

	describe("getSkillContent", () => {
		it("should load full skill content with instructions", async () => {
			const skillDir = path.join(GLOBAL_SKILLS_DIR, "my-skill")
			const skillMdPath = path.join(skillDir, "SKILL.md")

			fileExistsStub.withArgs(GLOBAL_SKILLS_DIR).resolves(true)
			fileExistsStub.withArgs(skillMdPath).resolves(true)
			isDirectoryStub.withArgs(GLOBAL_SKILLS_DIR).resolves(true)
			readdirStub.withArgs(GLOBAL_SKILLS_DIR).resolves(["my-skill"])
			statStub.withArgs(skillDir).resolves({ isDirectory: () => true })
			readFileStub.withArgs(skillMdPath, "utf-8").resolves(`---
name: my-skill
description: Test skill
---
These are the detailed instructions.

## Step 1
Do this first.

## Step 2
Then do this.`)

			const allSkills = await discoverSkills(TEST_CWD)
			const availableSkills = getAvailableSkills(allSkills)
			const content = await getSkillContent("my-skill", availableSkills)

			expect(content).to.not.be.null
			expect(content!.name).to.equal("my-skill")
			expect(content!.instructions).to.include("These are the detailed instructions")
			expect(content!.instructions).to.include("Step 1")
			expect(content!.instructions).to.include("Step 2")
		})

		it("should return null for non-existent skill", async () => {
			const content = await getSkillContent("non-existent", [])

			expect(content).to.be.null
		})

		it("should trim whitespace from instructions", async () => {
			const skillDir = path.join(GLOBAL_SKILLS_DIR, "my-skill")
			const skillMdPath = path.join(skillDir, "SKILL.md")

			fileExistsStub.withArgs(GLOBAL_SKILLS_DIR).resolves(true)
			fileExistsStub.withArgs(skillMdPath).resolves(true)
			isDirectoryStub.withArgs(GLOBAL_SKILLS_DIR).resolves(true)
			readdirStub.withArgs(GLOBAL_SKILLS_DIR).resolves(["my-skill"])
			statStub.withArgs(skillDir).resolves({ isDirectory: () => true })
			readFileStub.withArgs(skillMdPath, "utf-8").resolves(`---
name: my-skill
description: Test
---

   Instructions with whitespace   

`)

			const allSkills = await discoverSkills(TEST_CWD)
			const availableSkills = getAvailableSkills(allSkills)
			const content = await getSkillContent("my-skill", availableSkills)

			expect(content!.instructions).to.equal("Instructions with whitespace")
		})
	})
})
