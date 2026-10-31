import assert from "node:assert/strict"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import type { TaskStorageAddress } from "@core/storage/taskDirectory"
import { afterEach, beforeEach, describe, it } from "mocha"
import sinon from "sinon"
import { HostProvider } from "@/hosts/host-provider"
import { createTaskletId } from "@/shared/taskletId"
import { setVscodeHostProviderMock } from "@/test/host-provider-test-utils"
import { expectLoggerErrors } from "@/test/loggerGuard"
import { writePromptMetadataArtifacts } from "../TaskPromptArtifacts"

const environmentKeys = ["DIRAC_WRITE_PROMPT_ARTIFACTS", "DIRAC_PROMPT_ARTIFACT_DIR", "IS_DEV"] as const

describe("tasklet prompt artifacts", () => {
	let directory: string
	let cwd: string
	let environment: (string | undefined)[]
	let addresses: TaskStorageAddress[]

	beforeEach(async () => {
		directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "tasklet-prompts-")))
		cwd = path.join(directory, "workspace")
		await fs.mkdir(cwd)
		setVscodeHostProviderMock({ globalStorageFsPath: path.join(directory, "storage") })
		environment = environmentKeys.map((key) => process.env[key])
		for (const key of environmentKeys) delete process.env[key]
		addresses = [
			{ kind: "task", taskId: "root" },
			{ kind: "tasklet", rootTaskId: "root", taskletId: createTaskletId() },
			{ kind: "tasklet", rootTaskId: "root", taskletId: createTaskletId() },
		]
	})

	afterEach(async () => {
		sinon.restore()
		HostProvider.reset()
		environmentKeys.forEach((key, index) => {
			if (environment[index] === undefined) delete process.env[key]
			else process.env[key] = environment[index]
		})
		await fs.rm(directory, { recursive: true, force: true })
	})

	function write(storageAddress: TaskStorageAddress, systemPrompt: string, requestSeq = 1) {
		return writePromptMetadataArtifacts(
			{ taskId: "root", storageAddress, cwd, requestSeq, writePromptMetadataEnabled: true },
			{ systemPrompt, providerInfo: {} },
		)
	}

	function artifactPath(address: TaskStorageAddress, base = path.join(cwd, ".dirac-prompt-artifacts")) {
		return address.kind === "task"
			? path.join(base, `task-${address.taskId}-debug-001.md`)
			: path.join(
					base,
					"tasks",
					address.rootTaskId,
					"tasklets",
					address.taskletId,
					`task-${address.taskletId}-debug-001.md`,
				)
	}

	it("keeps concurrent root and sibling dumps distinct at the same request sequence", async () => {
		await Promise.all(addresses.map((address, index) => write(address, `prompt-${index}`)))
		for (const [index, address] of addresses.entries()) {
			assert.equal(await fs.readFile(artifactPath(address), "utf8"), `## System Prompt\n\nprompt-${index}\n\n`)
		}
		await assert.rejects(fs.stat(path.join(directory, "storage", "tasks")), { code: "ENOENT" })
	})

	it("qualifies a repeated tasklet ID by root and preserves the external environment destination", async () => {
		const base = path.join(directory, "external-debug")
		process.env.DIRAC_PROMPT_ARTIFACT_DIR = base
		const first = addresses[1] as Extract<TaskStorageAddress, { kind: "tasklet" }>
		const second = { ...first, rootTaskId: "another-root" }
		await Promise.all([write(first, "first"), write(second, "second")])
		assert.match(await fs.readFile(artifactPath(first, base), "utf8"), /first/)
		assert.match(await fs.readFile(artifactPath(second, base), "utf8"), /second/)
		await assert.rejects(fs.stat(path.join(cwd, ".dirac-prompt-artifacts")), { code: "ENOENT" })
	})

	it("does not redirect a sibling when another artifact write fails", async () => {
		expectLoggerErrors()
		const failedPath = artifactPath(addresses[1])
		const writeFile = fs.writeFile.bind(fs)
		sinon.stub(fs, "writeFile").callsFake(async (file, data, options) => {
			if (file === failedPath) throw new Error("injected prompt write failure")
			return writeFile(file, data, options)
		})
		// Debug artifact writes retain the existing best-effort logging contract.
		await Promise.all(addresses.map((address, index) => write(address, `prompt-${index}`)))
		await assert.rejects(fs.stat(failedPath), { code: "ENOENT" })
		assert.match(await fs.readFile(artifactPath(addresses[0]), "utf8"), /prompt-0/)
		assert.match(await fs.readFile(artifactPath(addresses[2]), "utf8"), /prompt-2/)
	})

	it("rejects invalid addresses before creating the debug directory", async () => {
		expectLoggerErrors()
		await write({ kind: "tasklet", rootTaskId: "../escape", taskletId: createTaskletId() }, "invalid")
		await assert.rejects(fs.stat(path.join(cwd, ".dirac-prompt-artifacts")), { code: "ENOENT" })
	})

	it("retains the workspace symlink boundary for contained dumps", async () => {
		const outside = path.join(directory, "outside")
		await fs.mkdir(outside)
		await fs.symlink(outside, path.join(cwd, ".dirac-prompt-artifacts"), "dir")
		await write(addresses[1], "must not be written")
		await assert.rejects(fs.stat(artifactPath(addresses[1], outside)), { code: "ENOENT" })
	})
})
