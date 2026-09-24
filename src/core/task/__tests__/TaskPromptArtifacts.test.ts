import { strict as assert } from "node:assert"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { afterEach, beforeEach, describe, it } from "mocha"
import { writePromptMetadataArtifacts } from "../TaskPromptArtifacts"

const ENVIRONMENT_KEYS = ["DIRAC_WRITE_PROMPT_ARTIFACTS", "DIRAC_PROMPT_ARTIFACT_DIR", "IS_DEV"] as const

// Flip the case of the last path segment, to stage a cwd whose spelling differs from the
// filesystem's own record of it -- the portable stand-in for a Windows drive-letter mismatch.
function caseVariant(p: string): string {
	const base = path.basename(p)
	const flipped = base === base.toUpperCase() ? base.toLowerCase() : base.toUpperCase()
	return path.join(path.dirname(p), flipped)
}

describe("TaskPromptArtifacts", () => {
	let cwd: string
	let originalEnvironment: Record<(typeof ENVIRONMENT_KEYS)[number], string | undefined>

	beforeEach(async () => {
		// realpath: on macOS os.tmpdir() is under a symlinked /tmp, and the writer resolves
		// symlinks before writing, so assertions must use the canonical path too.
		cwd = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "dirac-prompt-artifacts-")))
		originalEnvironment = {
			DIRAC_WRITE_PROMPT_ARTIFACTS: process.env.DIRAC_WRITE_PROMPT_ARTIFACTS,
			DIRAC_PROMPT_ARTIFACT_DIR: process.env.DIRAC_PROMPT_ARTIFACT_DIR,
			IS_DEV: process.env.IS_DEV,
		}
		for (const key of ENVIRONMENT_KEYS) delete process.env[key]
	})

	afterEach(async () => {
		for (const key of ENVIRONMENT_KEYS) {
			const value = originalEnvironment[key]
			if (value === undefined) delete process.env[key]
			else process.env[key] = value
		}
		await fs.rm(cwd, { recursive: true, force: true })
	})

	it("writes enabled prompt, tool, and full-history request data", async () => {
		const artifactDir = path.join(cwd, "artifacts")
		await writePromptMetadataArtifacts(
			{
				taskId: "task-1",
				requestSeq: 1,
				cwd,
				writePromptMetadataEnabled: true,
				writePromptMetadataDirectory: "artifacts",
			},
			{
				systemPrompt: "system prompt contents",
				providerInfo: { providerId: "anthropic", modelId: "primary-model" },
				tools: [{ name: "list_files", input_schema: { type: "object" } }],
				fullHistory: [
					{ role: "user", content: "first message" },
					{ role: "assistant", content: [{ type: "text", text: "second message" }] },
				],
				deletedRange: [0, 0],
			},
		)

		const markdown = await fs.readFile(path.join(artifactDir, "task-task-1-debug-001.md"), "utf8")
		assert.match(markdown, /## System Prompt\n\nsystem prompt contents/)
		assert.match(markdown, /"name": "list_files"/)
		assert.match(markdown, /### \[USER\] \[TRUNCATED\]\nfirst message/)
		assert.match(markdown, /### \[ASSISTANT\]\n\*\*Text:\*\* \nsecond message/)
		assert.equal(await fs.readFile(path.join(artifactDir, ".gitignore"), "utf8"), "*\n!.gitignore\n")
	})

	it("writes one artifact file per request instead of overwriting across a multi-call turn", async () => {
		const artifactDir = path.join(cwd, "artifacts")
		const baseParams = {
			cwd,
			writePromptMetadataEnabled: true,
			writePromptMetadataDirectory: "artifacts",
		}

		await writePromptMetadataArtifacts(
			{ taskId: "task-multi", requestSeq: 1, ...baseParams },
			{ systemPrompt: "first call", providerInfo: { providerId: "anthropic", modelId: "m" } },
		)
		await writePromptMetadataArtifacts(
			{ taskId: "task-multi", requestSeq: 2, ...baseParams },
			{ systemPrompt: "second call (the delivered answer)", providerInfo: { providerId: "anthropic", modelId: "m" } },
		)

		const first = await fs.readFile(path.join(artifactDir, "task-task-multi-debug-001.md"), "utf8")
		const second = await fs.readFile(path.join(artifactDir, "task-task-multi-debug-002.md"), "utf8")
		assert.match(first, /first call/)
		assert.match(second, /second call \(the delivered answer\)/)
	})

	// Regression: the containment guard used to compare resolved paths with a case-sensitive
	// `startsWith`. On Windows the workspace cwd (vscode.Uri.fsPath) and fs.realpath() disagree on
	// drive-letter case, so the guard rejected the extension's own artifact directory and the write
	// was skipped silently. A case-insensitive filesystem reproduces the same mismatch here.
	it("writes artifacts when cwd casing differs from the filesystem's", async function () {
		const variant = caseVariant(cwd)
		const insensitive = await fs
			.access(variant)
			.then(() => true)
			.catch(() => false)
		if (!insensitive) {
			this.skip() // case-sensitive filesystem: the mismatch cannot be staged here
		}

		await writePromptMetadataArtifacts(
			{ taskId: "task-case", requestSeq: 1, cwd: variant, writePromptMetadataEnabled: true },
			{ systemPrompt: "written despite cwd casing", providerInfo: { providerId: "anthropic", modelId: "m" } },
		)

		const markdown = await fs.readFile(path.join(cwd, ".dirac-prompt-artifacts", "task-task-case-debug-001.md"), "utf8")
		assert.match(markdown, /written despite cwd casing/)
	})

	it("does not create artifacts when output is disabled", async () => {
		await writePromptMetadataArtifacts(
			{
				taskId: "task-disabled",
				requestSeq: 1,
				cwd,
				writePromptMetadataEnabled: false,
			},
			{
				systemPrompt: "must not be written",
				providerInfo: { providerId: "anthropic", modelId: "primary-model" },
				tools: [],
				fullHistory: [],
			},
		)

		await fs.stat(path.join(cwd, ".dirac-prompt-artifacts")).then(
			() => assert.fail("disabled artifact generation should not create its output directory"),
			(error: NodeJS.ErrnoException) => assert.equal(error.code, "ENOENT"),
		)
	})
})
