/**
 * Characterization tests for parseSlashCommands.
 * Captures current behavior — bugs and all.
 *
 * Phase 0 — Prerequisite coverage for refactoring.
 * Covers: all tag patterns, all builtin commands, workflow & skill matching,
 * precedence rules, and edge cases (no match, partial match, empty input, multiple tags).
 */
import { expect } from "chai"
import * as fs from "fs"
import { afterEach, beforeEach, describe, it } from "mocha"
import * as sinon from "sinon"

import * as telemetry from "@/services/telemetry"
import { Logger } from "@/shared/services/Logger"
import * as skillsModule from "../../context/instructions/user-instructions/skills"
import { StateManager } from "../../storage/StateManager"
import { parseSlashCommands } from "../index"
import * as permissionsHandler from "../PermissionsCommandHandler"

const ULID = "test-ulid-123"

describe("parseSlashCommands", () => {
	let sandbox: sinon.SinonSandbox
	let captureStub: sinon.SinonStub

	beforeEach(() => {
		sandbox = sinon.createSandbox()
		// Silence logger noise
		sandbox.stub(Logger, "error")
		// Stub the telemetryService export directly (the Proxy closes over the
		// original getTelemetryService, so stubbing that export has no effect).
		captureStub = sandbox.stub()
		sandbox.stub(telemetry, "telemetryService").value({
			captureSlashCommandUsed: captureStub,
		} as any)
		// Stub StateManager.get to return a mock with empty remote workflow toggles
		sandbox.stub(StateManager, "get").returns({
			getGlobalStateKey: () => ({}),
		} as any)
	})

	afterEach(() => {
		sandbox.restore()
	})

	// Helper: invoke with minimal args and sensible defaults
	async function parse(
		text: string,
		opts: {
			localToggles?: Record<string, boolean>
			globalToggles?: Record<string, boolean>
			skills?: any[]
			permissionController?: any
			extensionPath?: string
			sourceDir?: string
		} = {},
	) {
		const result = await parseSlashCommands(
			text,
			opts.localToggles ?? {},
			opts.globalToggles ?? {},
			ULID,
			undefined,
			opts.skills ?? [],
			opts.permissionController,
			opts.extensionPath,
			opts.sourceDir ?? "dist/source",
		)
		// Flush microtasks so un-awaited telemetry proxy calls complete
		await new Promise((resolve) => setImmediate(resolve))
		return result
	}

	describe("no-match / passthrough cases", () => {
		it("returns original text unchanged when input is empty", async () => {
			const result = await parse("")
			expect(result.processedText).to.equal("")
			expect(result.needsDiracrulesFileCheck).to.be.false
		})

		it("returns original text when no XML tags are present", async () => {
			const text = "hello world, just chatting"
			const result = await parse(text)
			expect(result.processedText).to.equal(text)
			expect(result.needsDiracrulesFileCheck).to.be.false
		})

		it("returns original text when a tag has no slash command inside", async () => {
			const text = "<task>do something useful</task>"
			const result = await parse(text)
			expect(result.processedText).to.equal(text)
		})

		it("ignores slash commands that appear outside any tag", async () => {
			const text = "/newtask please help"
			const result = await parse(text)
			expect(result.processedText).to.equal(text)
		})

		it("does not match slash commands embedded in URLs or file paths", async () => {
			const text = "<task>see http://example.com/newtask and some/path/newtask</task>"
			const result = await parse(text)
			expect(result.processedText).to.equal(text)
		})

		it("does not treat a partial command name as a builtin", async () => {
			// /newtas is not a complete builtin command name
			const text = "<task>/newtas something</task>"
			const result = await parse(text)
			expect(result.processedText).to.equal(text)
		})
	})

	describe("tag patterns", () => {
		it("detects slash commands inside <task> tags", async () => {
			const text = "<task>/newtask</task>"
			const result = await parse(text)
			expect(result.processedText).to.not.equal(text)
			expect(result.processedText).to.contain("new_task")
		})

		it("detects slash commands inside <feedback> tags", async () => {
			const text = "<feedback>/smol</feedback>"
			const result = await parse(text)
			expect(result.processedText).to.contain("condense")
		})

		it("detects slash commands inside <answer> tags", async () => {
			const text = "<answer>/compact</answer>"
			const result = await parse(text)
			expect(result.processedText).to.contain("condense")
		})

		it("detects slash commands inside <user_message> tags", async () => {
			const text = "<user_message>/reportbug</user_message>"
			const result = await parse(text)
			expect(result.processedText).to.contain("report_bug")
		})

		it("is case-insensitive on the tag name but preserves command casing", async () => {
			const text = "<TASK>/newtask</TASK>"
			const result = await parse(text)
			expect(result.processedText).to.contain("new_task")
		})
	})

	describe("builtin commands", () => {
		it("handles /newtask and removes the slash command from text", async () => {
			const text = "<task>/newtask extra context here</task>"
			const result = await parse(text)
			expect(result.processedText).to.contain("new_task")
			expect(result.processedText).to.not.contain("/newtask")
			expect(result.processedText).to.contain("extra context here")
			expect(result.needsDiracrulesFileCheck).to.be.false
			expect(captureStub.calledWith(ULID, "newtask", "builtin")).to.be.true
		})

		it("handles /smol (alias for condense)", async () => {
			const result = await parse("<task>/smol</task>")
			expect(result.processedText).to.contain("condense")
			expect(captureStub.calledWith(ULID, "smol", "builtin")).to.be.true
		})

		it("handles /compact (alias for condense)", async () => {
			const result = await parse("<task>/compact</task>")
			expect(result.processedText).to.contain("condense")
			expect(captureStub.calledWith(ULID, "compact", "builtin")).to.be.true
		})

		it("handles /newrule and sets needsDiracrulesFileCheck to true", async () => {
			const result = await parse("<task>/newrule</task>")
			expect(result.processedText).to.contain("write_to_file")
			expect(result.processedText).to.not.contain("MUST use the new_rule tool")
			expect(result.needsDiracrulesFileCheck).to.be.true
			expect(captureStub.calledWith(ULID, "newrule", "builtin")).to.be.true
		})

		it("handles /reportbug", async () => {
			const result = await parse("<task>/reportbug</task>")
			expect(result.processedText).to.contain("report_bug")
			expect(captureStub.calledWith(ULID, "reportbug", "builtin")).to.be.true
		})

		it("handles /askDirac", async () => {
			const result = await parse("<task>/askDirac</task>")
			expect(result.processedText).to.contain("askDirac")
			expect(captureStub.calledWith(ULID, "askDirac", "builtin")).to.be.true
		})

		it("handles /reloadtools as a direct response", async () => {
			const result = await parse("<task>/reloadtools</task>")
			expect(result.isDirectResponse).to.be.true
			expect(result.directResponseText).to.equal("__RELOAD_TOOLS__")
			expect(result.processedText).to.equal("")
			expect(captureStub.calledWith(ULID, "reloadtools", "builtin")).to.be.true
		})

		it("handles /permissions with a permission controller", async () => {
			const fakeController = { addRule: sandbox.stub().resolves() } as any
			sandbox.stub(permissionsHandler, "handlePermissionsCommand").resolves({
				processedText: "Permission updated: allow Read **",
				success: true,
			})
			const result = await parse("<task>/permissions allow Read **</task>", {
				permissionController: fakeController,
			})
			expect(result.processedText).to.contain("explicit_instructions")
			expect(result.processedText).to.contain("Permission updated")
			expect(result.needsDiracrulesFileCheck).to.be.false
			expect(captureStub.calledWith(ULID, "permissions", "builtin")).to.be.true
		})
	})

	describe("workflow matching", () => {
		// Workflow fileName is the full basename (incl. extension), so the slash
		// command must include the extension to match.
		it("matches a local workflow by file name and injects its content", async () => {
			const workflowPath = "/home/user/.diracrules/my-workflow.md"
			sandbox.stub(fs.promises, "readFile").resolves("Workflow body content")
			const result = await parse("<task>/my-workflow.md do the thing</task>", {
				localToggles: { [workflowPath]: true },
			})
			expect(result.processedText).to.contain("my-workflow.md")
			expect(result.processedText).to.contain("Workflow body content")
			expect(result.processedText).to.not.contain("/my-workflow.md")
			expect(result.processedText).to.contain("do the thing")
			expect(captureStub.calledWith(ULID, "my-workflow.md", "workflow")).to.be.true
		})

		it("matches a global workflow when no local workflow matches", async () => {
			const globalPath = "/global/.diracrules/global-wf.md"
			sandbox.stub(fs.promises, "readFile").resolves("Global workflow content")
			const result = await parse("<task>/global-wf.md</task>", {
				globalToggles: { [globalPath]: true },
			})
			expect(result.processedText).to.contain("Global workflow content")
			expect(captureStub.calledWith(ULID, "global-wf.md", "workflow")).to.be.true
		})

		it("local workflow takes precedence over global workflow with same name", async () => {
			const localPath = "/local/.diracrules/dup.md"
			const globalPath = "/global/.diracrules/dup.md"
			const readFileStub = sandbox.stub(fs.promises, "readFile")
			readFileStub.withArgs(localPath, "utf8").resolves("LOCAL CONTENT")
			readFileStub.withArgs(globalPath, "utf8").resolves("GLOBAL CONTENT")
			const result = await parse("<task>/dup.md</task>", {
				localToggles: { [localPath]: true },
				globalToggles: { [globalPath]: true },
			})
			expect(result.processedText).to.contain("LOCAL CONTENT")
			expect(result.processedText).to.not.contain("GLOBAL CONTENT")
		})

		it("builtin command takes precedence over a same-named workflow", async () => {
			// Builtin "newtask" is checked before workflows; the .md workflow never matches
			const workflowPath = "/home/user/.diracrules/newtask.md"
			sandbox.stub(fs.promises, "readFile").resolves("should not be used")
			const result = await parse("<task>/newtask</task>", {
				localToggles: { [workflowPath]: true },
			})
			expect(result.processedText).to.contain("new_task")
			expect(result.processedText).to.not.contain("should not be used")
		})

		it("falls back to original text when workflow file read fails", async () => {
			const workflowPath = "/home/user/.diracrules/broken.md"
			sandbox.stub(fs.promises, "readFile").rejects(new Error("ENOENT"))
			const result = await parse("<task>/broken.md</task>", {
				localToggles: { [workflowPath]: true },
			})
			// On read error, the code falls through to skill check (none) then returns original
			expect(result.processedText).to.equal("<task>/broken.md</task>")
		})

		it("ignores disabled (toggled-off) workflows", async () => {
			const workflowPath = "/home/user/.diracrules/disabled.md"
			const result = await parse("<task>/disabled.md</task>", {
				localToggles: { [workflowPath]: false },
			})
			expect(result.processedText).to.equal("<task>/disabled.md</task>")
		})
	})

	describe("skill matching", () => {
		it("matches a skill by name and injects skill instructions", async () => {
			const skills = [{ name: "code-review", description: "reviews code", path: "/s/cr", source: "project" }]
			sandbox.stub(skillsModule, "getSkillContent").resolves({
				name: "code-review",
				description: "reviews code",
				path: "/s/cr",
				source: "project",
				instructions: "Review the code carefully.",
			})
			const result = await parse("<task>/code-review</task>", { skills })
			expect(result.processedText).to.contain("code-review")
			expect(result.processedText).to.contain("Review the code carefully.")
			expect(result.processedText).to.not.contain("/code-review")
			expect(captureStub.calledWith(ULID, "code-review", "skill")).to.be.true
		})

		it("adds an activation note when the tag content becomes empty after removing the command", async () => {
			const skills = [{ name: "solo-skill", description: "d", path: "/s", source: "global" }]
			sandbox.stub(skillsModule, "getSkillContent").resolves({
				name: "solo-skill",
				description: "d",
				path: "/s",
				source: "global",
				instructions: "Do the thing.",
			})
			const result = await parse("<task>/solo-skill</task>", { skills })
			expect(result.processedText).to.contain("explicitly activated")
			expect(result.processedText).to.contain("solo-skill")
		})

		it("does not add activation note when there is remaining tag content", async () => {
			const skills = [{ name: "ctx-skill", description: "d", path: "/s", source: "global" }]
			sandbox.stub(skillsModule, "getSkillContent").resolves({
				name: "ctx-skill",
				description: "d",
				path: "/s",
				source: "global",
				instructions: "Do the thing.",
			})
			const result = await parse("<task>/ctx-skill with extra info</task>", { skills })
			expect(result.processedText).to.not.contain("explicitly activated")
			expect(result.processedText).to.contain("with extra info")
		})

		it("falls back to original text when getSkillContent returns nothing", async () => {
			const skills = [{ name: "empty-skill", description: "d", path: "/s", source: "global" }]
			sandbox.stub(skillsModule, "getSkillContent").resolves(undefined as any)
			const result = await parse("<task>/empty-skill</task>", { skills })
			expect(result.processedText).to.equal("<task>/empty-skill</task>")
		})

		it("falls back to original text when getSkillContent throws", async () => {
			const skills = [{ name: "throw-skill", description: "d", path: "/s", source: "global" }]
			sandbox.stub(skillsModule, "getSkillContent").rejects(new Error("boom"))
			const result = await parse("<task>/throw-skill</task>", { skills })
			expect(result.processedText).to.equal("<task>/throw-skill</task>")
		})
	})

	describe("multiple tags / ordering", () => {
		it("processes the first tag that contains a slash command (tag order: task, feedback, answer, user_message)", async () => {
			// <feedback> appears later in text but <task> is checked first by the loop
			const text = "<feedback>/smol</feedback> <task>/newtask</task>"
			const result = await parse(text)
			// task is checked first in tagPatterns order, so /newtask wins
			expect(result.processedText).to.contain("new_task")
		})

		it("skips a tag with no slash command and processes a later tag that has one", async () => {
			const text = "<task>no command here</task> <feedback>/smol</feedback>"
			const result = await parse(text)
			expect(result.processedText).to.contain("condense")
		})
	})
})
