import { strict as assert } from "node:assert"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { getTaskDirectoryPath, type TaskStorageAddress } from "@core/storage/taskDirectory"
import { HostProvider } from "@hosts/host-provider"
import { createTaskletId } from "@shared/taskletId"
import { afterEach, beforeEach, describe, it } from "mocha"
import sinon from "sinon"
import type { IToolEnvironment } from "../../../interfaces/IToolEnvironment"
import { ToolRegistry } from "../../../registry/ToolRegistry"
import { UpsertTool } from "../UpsertTool"
import { smokeHarnessPath, toolDefinition } from "./upsert-test-fixture"

describe("UpsertTool storage address forwarding", () => {
	let directory: string
	const sandbox = sinon.createSandbox()

	beforeEach(async () => {
		directory = await fs.mkdtemp(path.join(os.tmpdir(), "tasklet-upsert-address-"))
		sandbox.stub(HostProvider, "get").returns({ globalStorageFsPath: directory } as HostProvider)
		ToolRegistry.resetInstance()
	})

	afterEach(async () => {
		sandbox.restore()
		ToolRegistry.resetInstance()
		await fs.rm(directory, { recursive: true, force: true })
	})

	for (const kind of ["legacy", "root", "tasklet"] as const) {
		it(`prepares ${kind} task tools in the addressed directory`, async () => {
			const address: TaskStorageAddress = kind === "tasklet"
				? { kind: "tasklet", rootTaskId: "root", taskletId: createTaskletId() }
				: { kind: "task", taskId: "root" }
			const expected = path.join(getTaskDirectoryPath(address), "tool-builds")
			const validate = sandbox.stub().callsFake(async (command: string) => {
				const harnessPath = smokeHarnessPath(command)
				const toolDir = path.dirname(harnessPath)
				assert.equal(path.dirname(toolDir), expected)
				assert.equal(JSON.parse(await fs.readFile(path.join(toolDir, "dirac-tool.json"), "utf8")).name, "example_tool")
				assert.deepEqual(JSON.parse(await fs.readFile(path.join(toolDir, "smoke-args.json"), "utf8")), { message: "hello" })
				// Reject the authorized smoke command: address forwarding/staging is under test, not execution.
				return { userRejected: true, completed: true, exitCode: 0, output: "" }
			})
			const runSubagent = sandbox.stub().rejects(new Error("no builder may run"))
			const env = {
				config: {
					taskId: address.kind === "tasklet" ? address.taskletId : address.taskId,
					storageAddress: kind === "legacy" ? undefined : address,
					callbacks: {
						withMutationAuthorization: async (_name: unknown, mutation: () => Promise<unknown>) => mutation(),
						transitionFromMutation: async (transition: () => Promise<unknown>) => transition(),
						commitEnabledToolToggles: async (_ids: string[], finalize: () => Promise<void>) => finalize(),
					},
				},
				system: { executeCommand: validate },
				ui: { createCard: async () => ({ update: async () => undefined, finalize: async () => undefined }) },
				orchestration: { getTaskState: () => [], setTaskState: () => undefined, runSubagent },
			} as unknown as IToolEnvironment
			const result = await new UpsertTool().processCall({ tools: [toolDefinition({ scope: "task" })] }, env)
			assert.match(result, /rejected/i)
			sinon.assert.calledOnce(validate)
			sinon.assert.notCalled(runSubagent)
			assert.deepEqual(await fs.readdir(path.join(directory, "tasks")), ["root"])
			assert.deepEqual(await fs.readdir(expected), [])
		})
	}
})
