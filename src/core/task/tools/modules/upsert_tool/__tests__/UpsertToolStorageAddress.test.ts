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
import * as builder from "../subagent-builder"
import { UpsertTool } from "../UpsertTool"

describe("UpsertTool storage address forwarding", () => {
	let directory: string
	const sandbox = sinon.createSandbox()

	beforeEach(async () => {
		directory = await fs.mkdtemp(path.join(os.tmpdir(), "tasklet-upsert-address-"))
		sandbox.stub(HostProvider, "get").returns({ globalStorageFsPath: directory } as HostProvider)
	})

	afterEach(async () => {
		sandbox.restore()
		await fs.rm(directory, { recursive: true, force: true })
	})

	for (const kind of ["legacy", "root", "tasklet"] as const) {
		it(`prepares ${kind} task tools in the addressed directory`, async () => {
			const address: TaskStorageAddress = kind === "tasklet"
				? { kind: "tasklet", rootTaskId: "root", taskletId: createTaskletId() }
				: { kind: "task", taskId: "root" }
			const expected = path.join(getTaskDirectoryPath(address), "tool-builds")
			const build = sandbox.stub(builder, "buildToolWithRepairs").callsFake(async (_env, input) => {
				assert.equal(path.dirname(input.toolDir), expected)
				assert.equal(JSON.parse(await fs.readFile(path.join(input.toolDir, "dirac-tool.json"), "utf8")).name, "example_tool")
				// Stop before the old builder workflow: only address forwarding/staging is under test.
				return "controlled builder stop"
			})
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
				ui: { createCard: async () => ({ update: async () => undefined, finalize: async () => undefined }) },
				orchestration: { getTaskState: () => [], setTaskState: () => undefined },
			} as unknown as IToolEnvironment
			const result = await new UpsertTool().processCall({
				tools: [{
					name: "example_tool", scope: "task", description: "Example", parameters: [], requirements: "Return example",
				}]
			}, env)
			assert.match(result, /controlled builder stop/)
			sinon.assert.calledOnce(build)
			assert.deepEqual(await fs.readdir(path.join(directory, "tasks")), ["root"])
			assert.deepEqual(await fs.readdir(expected), [])
		})
	}
})
