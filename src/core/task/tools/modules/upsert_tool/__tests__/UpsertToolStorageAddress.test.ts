import { strict as assert } from "node:assert"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { getTaskDirectoryPath, type TaskStorageAddress } from "@core/storage/taskDirectory"
import { HostProvider } from "@hosts/host-provider"
import { createTaskletFixtureId as createTaskletId } from "@/test/taskletFixtures"
import { afterEach, beforeEach, describe, it } from "mocha"
import sinon from "sinon"
import type { IToolEnvironment } from "../../../interfaces/IToolEnvironment"
import { ToolRegistry } from "../../../registry/ToolRegistry"
import { UpsertTool } from "../UpsertTool"
import { createUpsertFixture, smokeHarnessPath, successfulSmoke, toolDefinition } from "./upsert-test-fixture"

describe("UpsertTool root-owned task storage", () => {
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
		it(`stages and installs ${kind} task tools in the root directory under the root owner`, async () => {
			const address: TaskStorageAddress = kind === "tasklet"
				? { kind: "tasklet", rootTaskId: "root", taskletId: createTaskletId() }
				: { kind: "task", taskId: "root" }
			const rootDirectory = getTaskDirectoryPath("root")
			const expected = path.join(rootDirectory, "tool-builds")
			let taskScopedToolIds: string[] = []
			const validate = sandbox.stub().callsFake(async (command: string) => {
				const harnessPath = smokeHarnessPath(command)
				const toolDir = path.dirname(harnessPath)
				assert.equal(path.dirname(toolDir), expected)
				assert.equal(JSON.parse(await fs.readFile(path.join(toolDir, "dirac-tool.json"), "utf8")).name, "example_tool")
				assert.deepEqual(JSON.parse(await fs.readFile(path.join(toolDir, "smoke-args.json"), "utf8")), { message: "hello" })
				// Keep staging, promotion and registration real; command execution is controlled.
				return { ...successfulSmoke }
			})
			const runSubagent = sandbox.stub().rejects(new Error("no builder may run"))
			const env = {
				config: {
					taskId: address.kind === "tasklet" ? address.taskletId : address.taskId,
					storageAddress: kind === "legacy" ? undefined : address,
					autoApprover: { isUnrestrictedAutoApprove: () => true },
					services: { commandPermissionController: { assertConfigurationValid: sinon.stub() } },
					callbacks: {
						withMutationAuthorization: async (_name: unknown, mutation: () => Promise<unknown>) => mutation(),
						transitionFromMutation: async (transition: () => Promise<unknown>) => transition(),
						commitEnabledToolToggles: async (_ids: string[], finalize: () => Promise<void>) => finalize(),
					},
				},
				system: { executeCommand: validate },
				ui: { createCard: async () => ({ update: async () => undefined, finalize: async () => undefined }) },
				orchestration: {
					reportFailure: sandbox.stub(),
					getTaskState: (key: string) => key === "abortSignal" ? new AbortController().signal : taskScopedToolIds,
					setTaskState: (_key: string, ids: string[]) => { taskScopedToolIds = ids },
					runSubagent,
				},
			} as unknown as IToolEnvironment
			const result = await new UpsertTool().processCall({ tools: [toolDefinition({ scope: "task" })] }, env)
			assert.match(result, /✓.*example_tool.*ready/)
			const installed = ToolRegistry.getInstance().getAllTools("root")
			assert.equal(installed.length, 1)
			assert.equal(installed[0].ownerTaskId, "root")
			assert.equal(installed[0].modulePath, path.join(rootDirectory, "tools", "example_tool", "tool.ts"))
			assert.deepEqual(taskScopedToolIds, ["example_tool"])
			if (address.kind === "tasklet") {
				assert.deepEqual(ToolRegistry.getInstance().getAllTools(address.taskletId), [])
				await assert.rejects(fs.access(getTaskDirectoryPath(address)), { code: "ENOENT" })
			}
			sinon.assert.calledOnce(validate)
			sinon.assert.notCalled(runSubagent)
			assert.deepEqual(await fs.readdir(path.join(directory, "tasks")), ["root"])
			assert.deepEqual(await fs.readdir(expected), [])
		})
	}

	it("waits before authorizing a same-root upsert until rollback finishes, without blocking another root", async () => {
		const fixture = await createUpsertFixture()
		let releaseFailedCommit!: () => void
		const failedCommitBarrier = new Promise<void>((resolve) => { releaseFailedCommit = resolve })
		try {
			const environment = (rootTaskId: string, taskletId: string) => {
				const authorize = sandbox.stub().callsFake(async (_name: string, mutation: () => Promise<unknown>) => mutation())
				const env = {
					...fixture.env,
					config: {
						...fixture.env.config,
						taskId: taskletId,
						storageAddress: { kind: "tasklet" as const, rootTaskId, taskletId },
						callbacks: { ...fixture.env.config.callbacks, withMutationAuthorization: authorize },
					},
				} as IToolEnvironment
				return { env, authorize }
			}
			const first = environment("root", createTaskletId())
			const sibling = environment("root", createTaskletId())
			const unrelated = environment("other-root", first.env.config.taskId)
			const tool = new UpsertTool()
			const baseline = toolDefinition({ scope: "task", implementation: 'return "baseline"' })
			assert.match(await tool.processCall({ tools: [baseline] }, first.env), /ready/)
			const previous = ToolRegistry.getInstance().getAllTools("root")[0]
			const previousSource = await fs.readFile(previous.modulePath, "utf8")
			let commitStarted!: () => void
			const commitStartedBarrier = new Promise<void>((resolve) => { commitStarted = resolve })
			fixture.commitEnabledToolToggles.onSecondCall().callsFake(async (_ids: string[], commit: () => Promise<void>) => {
				await commit()
				commitStarted()
				await failedCommitBarrier
				throw new Error("controlled post-promotion commit failure")
			})
			const failed = assert.rejects(tool.processCall({
				tools: [toolDefinition({ scope: "task", implementation: 'return "failed update"' })],
			}, first.env), /controlled post-promotion commit failure/)
			await commitStartedBarrier
			sibling.authorize.callsFake(async (_name: string, mutation: () => Promise<unknown>) => {
				assert.equal(ToolRegistry.getInstance().getAllTools("root")[0], previous)
				assert.equal(await fs.readFile(previous.modulePath, "utf8"), previousSource)
				return mutation()
			})
			const next = tool.processCall({
				tools: [toolDefinition({ scope: "task", implementation: 'return "sibling update"' })],
			}, sibling.env)
			await new Promise((resolve) => setImmediate(resolve))
			sinon.assert.notCalled(sibling.authorize)
			assert.equal(fixture.executeCommand.callCount, 2)
			assert.match(await tool.processCall({
				tools: [toolDefinition({ scope: "task", implementation: 'return "unrelated version"' })],
			}, unrelated.env), /ready/)
			sinon.assert.calledOnce(unrelated.authorize)
			sinon.assert.notCalled(sibling.authorize)
			releaseFailedCommit()
			await failed
			assert.match(await next, /ready/)
			sinon.assert.calledOnce(sibling.authorize)
			const registry = ToolRegistry.getInstance()
			assert.match(await fs.readFile(registry.getAllTools("root")[0].modulePath, "utf8"), /sibling update/)
			assert.match(await fs.readFile(registry.getAllTools("other-root")[0].modulePath, "utf8"), /unrelated version/)
			assert.deepEqual(await fs.readdir(path.join(getTaskDirectoryPath("root"), "tool-builds")), [])
		} finally {
			releaseFailedCommit()
			await fixture.dispose()
		}
	})
})
