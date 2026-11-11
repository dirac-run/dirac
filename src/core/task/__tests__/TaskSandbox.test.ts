import assert from "node:assert/strict"
import { describe, it } from "mocha"
import sinon from "sinon"
import { DEFAULT_SANDBOX_SETTINGS } from "@shared/SandboxSettings"
import { captureSandboxExecution } from "@shared/SandboxExecution"
import * as sandboxExecution from "@shared/SandboxExecution"
import { tmpdir } from "node:os"
import type { CommandExecutionOptions } from "@integrations/terminal"
import { captureSandboxTaskPolicy } from "@integrations/terminal/sandbox/taskPolicy"
import { Task } from "../index"

function fixture(profile: string = "standalone") {
	let settings = { ...DEFAULT_SANDBOX_SETTINGS }
	const abort = new AbortController()
	const execute = sinon.stub().callsFake(async (_command: string, _timeout: number | undefined, options: CommandExecutionOptions) => {
		options.assertAuthorized?.()
		return [false, "executed"]
	})
	const task = Object.assign(Object.create(Task.prototype), {
		executionProfile: profile,
		cwd: "/workspace", workspaceManager: { getRoots: () => [{ path: "/workspace" }, { path: "/secondary" }] },
		stateManager: { getSystemDefaultSettingsKey: () => settings, getStorageDirectories: () => ({ diracDir: "/actual-home", dataDir: "/actual-home/data", workspaceStoragePath: "/external-storage" }) },
		taskState: { abortSignal: abort.signal }, commandExecutor: { execute },
	}) as Task
	return { task, execute, abort, settings: () => settings, change: (next: Partial<typeof settings>) => { settings = { ...settings, ...next } } }
}

describe("Task sandbox settings authority", () => {
	it("passes the actual execution host into preset resolution before approval", () => {
		const capture = sinon.spy(sandboxExecution, "captureSandboxExecution")
		try {
			fixture().task.captureCommandSandbox()
			assert.deepEqual(capture.firstCall.args[2], { platform: process.platform, temporaryDirectory: tmpdir() })
		} finally { capture.restore() }
	})
	it("launches explicit pinned task policy without fallback and refuses off/current-ceiling changes", async function () {
		if (process.platform !== "linux" || process.arch !== "x64") this.skip()
		const fs = await import("node:fs/promises"), os = await import("node:os"), path = await import("node:path")
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "task-sandbox-policy-"))
		try {
			const workspace = path.join(root, "workspace"), temp = path.join(root, "temp")
			await fs.mkdir(workspace); await fs.mkdir(temp)
			const profile: import("@shared/SandboxSettings").CustomSandboxProfile = { id: "ceiling", name: "Ceiling", description: "", revision: 1, kind: "custom", filesystem: { base: "selected", workspace: "read-write", readable: [], writable: [], blocked: [], caches: [] }, temporaryDirectory: temp, network: "deny", environment: { passthrough: [], overrides: {} } }
			const test = fixture("tasklet")
			test.change({ enabled: true, allowUnsandboxedFallback: true, subagentProfileId: profile.id, profiles: [profile] })
			const policy = captureSandboxTaskPolicy(test.settings(), { restrictions: { workspace: "read-only" } }, [workspace])
			Object.assign(test.task, { cwd: workspace, workspaceManager: { getRoots: () => [{ path: workspace }] }, taskletConfiguration: { sandboxPolicy: policy } })
			const captured = test.task.captureCommandSandbox()
			assert.equal(captured.allowUnsandboxedFallback, false)
			await test.task.executeCommandTool("echo bounded", undefined, { sandboxContext: captured })
			assert.equal(test.execute.firstCall.args[2].sandboxContext.profile.filesystem.workspace, "read-only")
			assert.equal(test.execute.firstCall.args[2].sandbox.allowUnsandboxedFallback, false)
			assert.deepEqual(test.execute.firstCall.args[2].sandbox.context.pathIdentities, policy.pathIdentities)
			test.change({ subagentProfileId: "default", profiles: [] })
			assert.equal(test.task.captureCommandSandbox().profile.id, "ceiling")
			test.change({ enabled: false })
			await assert.rejects(test.task.executeCommandTool("never runs", undefined, { sandboxContext: captured }), /enabled/)
		} finally { await fs.rm(root, { recursive: true, force: true }) }
	})
	for (const profile of ["standalone", "goal_coordinator", "tasklet"]) {
		it(`uses the trusted ${profile === "tasklet" ? "subagent (also nested children)" : "main-agent"} assignment for ${profile}`, async () => {
			const test = fixture(profile)
			await test.task.executeCommandTool("echo off", undefined)
			assert.equal(test.execute.firstCall.args[2].sandbox, undefined)
			assert.equal(test.execute.firstCall.args[2].sandboxContext.role, profile === "tasklet" ? "subagent" : "main")
			test.change({ enabled: true })
			await test.task.executeCommandTool("echo default", undefined)
			assert.deepEqual(test.execute.secondCall.args[2].sandbox, { profile: "default", allowUnsandboxedFallback: false, context: { workspaceRoots: ["/workspace", "/secondary"], protectedPaths: ["/actual-home", "/actual-home/data", "/external-storage"] } })
			assert.equal(Object.isFrozen(test.execute.secondCall.args[2].sandboxContext), true)
		})
	}

	for (const key of ["enabled", "allowUnsandboxedFallback", "mainAgentProfileId"] as const) {
		it(`rejects changed ${key} between approval and launch`, async () => {
			const test = fixture()
			const captured = captureSandboxExecution(test.settings(), false)
			test.change(key === "mainAgentProfileId" ? { mainAgentProfileId: "unsupported" } : { [key]: true })
			await assert.rejects(test.task.executeCommandTool("never runs", undefined, { sandboxContext: captured }), /Sandbox|sandbox/)
		})
	}

	it("does not let disabled or malformed settings bypass validation", async () => {
		const test = fixture()
		test.change({ subagentProfileId: "unsupported" })
		await assert.rejects(test.task.executeCommandTool("never runs", undefined), /profile/i)
		sinon.assert.notCalled(test.execute)
	})

	it("freezes custom content and revision before approval and rejects either changed at launch", async () => {
		const profile: import("@shared/SandboxSettings").CustomSandboxProfile = {
			id: "custom", name: "Workspace", description: "Explicit policy", kind: "custom", revision: 1,
			filesystem: { base: "selected", workspace: "read-only", readable: [], writable: [], blocked: [], caches: [] },
			temporaryDirectory: "/tmp/private", network: "deny", environment: { passthrough: ["PATH"], overrides: { B: "2", A: "1" } },
		}
		const test = fixture("tasklet")
		test.change({ enabled: true, subagentProfileId: profile.id, profiles: [profile] })
		const captured = captureSandboxExecution(test.settings(), true)
		assert.equal(captured.profile.revision, 1)
		assert.ok("kind" in captured.profile && Object.isFrozen(captured.profile.environment.overrides))
		profile.environment.overrides.A = "changed after approval"
		assert.ok("kind" in captured.profile && captured.profile.environment.overrides.A === "1")
		await assert.rejects(test.task.executeCommandTool("never runs", undefined, { sandboxContext: captured }), /settings changed/)
		profile.environment.overrides.A = "1"
		profile.revision = 2
		await assert.rejects(test.task.executeCommandTool("never runs", undefined, { sandboxContext: captured }), /settings changed/)
	})

	it("exposes actual configured storage roots rather than assuming a home directory", async () => {
		const fs = await import("node:fs/promises"), os = await import("node:os"), path = await import("node:path")
		const { createStorageContext } = await import("@shared/storage/storage-context")
		const { StateManager } = await import("@core/storage/StateManager")
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "dirac-storage-roots-"))
		try {
			const diracDir = path.join(root, "custom-home"), workspaceStoragePath = path.join(root, "external-state")
			const storage = createStorageContext({ diracDir, workspaceStorageDir: workspaceStoragePath })
			const manager = Object.assign(Object.create(StateManager.prototype), { storage }) as import("@core/storage/StateManager").StateManager
			assert.deepEqual(manager.getStorageDirectories(), { diracDir, dataDir: path.join(diracDir, "data"), workspaceStoragePath })
		} finally { await fs.rm(root, { recursive: true, force: true }) }
	})

	it("preserves original approval checks and abort at the final synchronous boundary", async () => {
		const test = fixture()
		const original = sinon.stub().throws(new Error("approval revoked"))
		await assert.rejects(test.task.executeCommandTool("never runs", undefined, { assertAuthorized: original }), /approval revoked/)
		sinon.assert.calledOnce(original)
		test.abort.abort(new Error("task aborted"))
		await assert.rejects(test.task.executeCommandTool("never runs", undefined), /task aborted/)
	})
})
