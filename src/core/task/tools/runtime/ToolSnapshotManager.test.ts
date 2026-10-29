import { strict as assert } from "node:assert"
import { afterEach, beforeEach, describe, it } from "mocha"
import sinon from "sinon"
import type { SystemPromptContext } from "@core/prompts/system-prompt/types"
import { setHostCapabilities } from "@/hosts/host-capabilities"
import { diagnostics_scan_spec, DiagnosticsScanTool } from "../modules/diagnostics_scan"
import type { DiracDefaultTool, DiracToolSpec } from "@shared/tools"
import { ToolDiscoveryService } from "../discovery/ToolDiscoveryService"
import type { DiscoveredTool } from "../discovery/DiscoveredTool"
import { ToolRegistry } from "../registry/ToolRegistry"
import { refreshTaskTools } from "../registry/refreshToolRegistry"
import { ToolSnapshotManager } from "./ToolSnapshotManager"
import type { ToolSelectionPolicy } from "./ToolSelectionPolicy"

function makeTool(id: string): DiscoveredTool {
	return {
		id,
		name: id,
		source: "builtin",
		exposure: { kind: "configurable" },
		spec: { id: id as DiracDefaultTool, name: id, description: `Test tool ${id}` } as DiracToolSpec,
		factory: () => ({
			spec: () => ({ id: id as DiracDefaultTool, name: id, description: `Test tool ${id}` }) as DiracToolSpec,
			supportedSurfaces: () => ["all"],
			processCall: async () => "ok",
		}),
		modulePath: `modules/${id}/tool.ts`,
	}
}

function createManager(
	toggles: Record<string, boolean>,
	taskId = "task-id",
	workspaceRoot = "/test-workspace",
	selectionPolicy?: ToolSelectionPolicy,
) {
	return new ToolSnapshotManager({
		createTaskConfig: () => ({}) as never,
		getTaskId: () => taskId,
		getWorkspaceRoot: () => workspaceRoot,
		getToggles: () => toggles,
		getSelectionPolicy: () => selectionPolicy,
		getActiveSkills: () => [],
	})
}

const context = {
	providerInfo: { providerId: "anthropic", model: { id: "test-model", info: {} } },
} as SystemPromptContext

describe("ToolSnapshotManager task isolation", () => {
	beforeEach(() => {
		ToolRegistry.resetInstance()
		ToolRegistry.getInstance().registerBuiltin(makeTool("alpha"))
		ToolRegistry.getInstance().registerBuiltin(makeTool("beta"))
		sinon.stub(ToolDiscoveryService, "scanBuiltinTools").returns([])
		sinon.stub(ToolDiscoveryService, "scanGlobalUserTools").resolves([])
	})

	afterEach(() => {
		sinon.restore()
		setHostCapabilities(undefined)
	})

	for (const available of [false, true]) {
		it(`${available ? "exposes" : "omits"} diagnostics in the model and runtime when host support is ${available}`, async () => {
			setHostCapabilities(available ? { editorDiagnostics: true } : {})
			ToolRegistry.getInstance().registerBuiltin({
				...makeTool("diagnostics_scan"),
				spec: diagnostics_scan_spec,
				factory: () => new DiagnosticsScanTool(),
			})
			sinon.stub(ToolDiscoveryService, "scanWorkspaceTools").resolves([])
			const snapshot = await createManager(
				{ diagnostics_scan: true },
				"task-id",
				"/test-workspace",
				{ mode: "delta", enabledToolIds: ["diagnostics_scan"], disabledToolIds: [] },
			).getSnapshotForRequest(context, { requestId: `diagnostics-${available}`, configurationRevision: 1 })

			assert.equal(snapshot.promptVisibleSpecs.some((spec) => spec.name === "diagnostics_scan"), available)
			assert.equal(snapshot.nativeTools.some((tool) => "name" in tool && tool.name === "diagnostics_scan"), available)
			assert.equal(snapshot.inventoryEnabledTools.some((tool) => tool.id === "diagnostics_scan"), available)
			assert.equal(snapshot.executableToolNames.has("diagnostics_scan"), available)
			assert.equal(snapshot.coordinator.has("diagnostics_scan"), available)
		})
	}

	it("applies invocation selection after configured toggles", async () => {
		const exact = createManager(
			{ alpha: true, beta: true },
			"task-id",
			"/test-workspace",
			{ mode: "exact", toolIds: ["beta"] },
		)
		const delta = createManager(
			{ alpha: false, beta: true },
			"task-id",
			"/test-workspace",
			{ mode: "delta", enabledToolIds: ["alpha"], disabledToolIds: ["beta"] },
		)

		const exactSnapshot = await exact.getSnapshotForRequest(context, { requestId: "exact", configurationRevision: 1 })
		const deltaSnapshot = await delta.getSnapshotForRequest(context, { requestId: "delta", configurationRevision: 1 })
		assert.deepEqual(exactSnapshot.inventoryEnabledTools.map((tool) => tool.id), ["beta"])
		assert.deepEqual(deltaSnapshot.inventoryEnabledTools.map((tool) => tool.id), ["alpha"])
	})

	it("serializes process-global registry mutation into detached per-Task snapshots", async () => {
		const managerA = createManager({ alpha: true, beta: false })
		const managerB = createManager({ alpha: false, beta: true })

		let releaseFirstScan!: () => void
		const firstScanBarrier = new Promise<void>((resolve) => {
			releaseFirstScan = resolve
		})
		let firstScanStarted!: () => void
		const firstScanStartedBarrier = new Promise<void>((resolve) => {
			firstScanStarted = resolve
		})
		const workspaceScan = sinon.stub(ToolDiscoveryService, "scanWorkspaceTools")
		workspaceScan.onFirstCall().callsFake(async () => {
			firstScanStarted()
			await firstScanBarrier
			return []
		})
		workspaceScan.onSecondCall().resolves([])

		const snapshotAPromise = managerA.getSnapshotForRequest(context, { requestId: "request-a", configurationRevision: 1 })
		await firstScanStartedBarrier
		const snapshotBPromise = managerB.getSnapshotForRequest(context, { requestId: "request-b", configurationRevision: 1 })
		releaseFirstScan()

		const [snapshotA, snapshotB] = await Promise.all([snapshotAPromise, snapshotBPromise])
		assert.deepEqual(snapshotA.inventoryEnabledTools.map((tool) => tool.id), ["alpha"])
		assert.deepEqual(snapshotB.inventoryEnabledTools.map((tool) => tool.id), ["beta"])
		assert.deepEqual(snapshotA.inventoryEnabledTools.map((tool) => tool.id), ["alpha"])
	})

	it("keeps custom tool inventories isolated across workspaces", async () => {
		const workspaceTool = (id: string, workspaceRoot: string): DiscoveredTool => ({
			...makeTool(id),
			source: "workspace",
			modulePath: `${workspaceRoot}/.dirac/tools/${id}/tool.ts`,
		})
		const workspaceScan = sinon.stub(ToolDiscoveryService, "scanWorkspaceTools")
		workspaceScan.withArgs("/workspace-a").resolves([workspaceTool("only_a", "/workspace-a")])
		workspaceScan.withArgs("/workspace-b").resolves([workspaceTool("only_b", "/workspace-b")])

		const managerA = createManager({ only_a: true }, "task-a", "/workspace-a")
		const managerB = createManager({ only_b: true }, "task-b", "/workspace-b")
		const snapshotA1 = await managerA.getSnapshotForRequest(context, {
			requestId: "request-a-1",
			configurationRevision: 1,
		})
		const snapshotB = await managerB.getSnapshotForRequest(context, {
			requestId: "request-b",
			configurationRevision: 1,
		})
		const snapshotA2 = await managerA.getSnapshotForRequest(context, {
			requestId: "request-a-2",
			configurationRevision: 1,
		})

		assert.deepEqual(snapshotA1.inventoryEnabledTools.map((tool) => tool.id).sort(), ["alpha", "beta", "only_a"])
		assert.deepEqual(snapshotB.inventoryEnabledTools.map((tool) => tool.id).sort(), ["alpha", "beta", "only_b"])
		assert.deepEqual(snapshotA2.inventoryEnabledTools.map((tool) => tool.id).sort(), ["alpha", "beta", "only_a"])
	})

	it("serializes task-tool registration with request snapshot capture", async () => {
		const diskModule = require("@core/storage/disk")
		sinon.stub(diskModule, "ensureTaskDirectoryExists").resolves("/test/task")
		const taskTool = { ...makeTool("task-tool"), source: "task" as const, ownerTaskId: "task-id" }
		sinon.stub(ToolDiscoveryService, "scanUserToolDirectory").resolves([taskTool])
		const registry = ToolRegistry.getInstance()
		const registerSpy = sinon.spy(registry, "registerUserTool")

		let releaseRegistry!: () => void
		const registryBarrier = new Promise<void>((resolve) => {
			releaseRegistry = resolve
		})
		let registryAcquired!: () => void
		const registryAcquiredBarrier = new Promise<void>((resolve) => {
			registryAcquired = resolve
		})
		const lockPromise = ToolRegistry.withExclusiveAccess(async () => {
			registryAcquired()
			await registryBarrier
		})
		await registryAcquiredBarrier

		const refreshPromise = refreshTaskTools("task-id")
		await new Promise((resolve) => setImmediate(resolve))
		assert.equal(registerSpy.called, false)

		releaseRegistry()
		await lockPromise
		assert.deepEqual(await refreshPromise, ["task-tool"])
		assert.equal(registerSpy.called, false)
		assert.equal(registry.getAllTools("task-id").some((tool) => tool.id === "task-tool"), true)
	})

	it("keeps colliding task tools owner-scoped and removes only the addressed owner", async () => {
		const registry = ToolRegistry.getInstance()
		const taskATool = {
			...makeTool("same-name"),
			source: "task" as const,
			ownerTaskId: "task-a",
			modulePath: "/tasks/a/tools/same-name/tool.ts",
		}
		const taskBTool = {
			...makeTool("same-name"),
			source: "task" as const,
			ownerTaskId: "task-b",
			modulePath: "/tasks/b/tools/same-name/tool.ts",
		}
		registry.replaceUserTool(taskATool, true)
		registry.replaceUserTool(taskBTool, true)

		const snapshotA = await createManager({}, "task-a").getSnapshotForRequest(context, {
			requestId: "request-a",
			configurationRevision: 1,
		})
		const snapshotB = await createManager({}, "task-b").getSnapshotForRequest(context, {
			requestId: "request-b",
			configurationRevision: 1,
		})

		assert.equal(snapshotA.inventoryEnabledTools.find((tool) => tool.id === "same-name")?.modulePath, taskATool.modulePath)
		assert.equal(snapshotB.inventoryEnabledTools.find((tool) => tool.id === "same-name")?.modulePath, taskBTool.modulePath)
		assert.equal(registry.getAllTools().some((tool) => tool.source === "task"), false)

		registry.removeTaskTools("task-a")
		assert.equal(registry.getAllTools("task-a").some((tool) => tool.id === "same-name"), false)
		assert.equal(registry.getAllTools("task-b").find((tool) => tool.id === "same-name")?.modulePath, taskBTool.modulePath)
	})


	it("reconciles deleted task tools out of the owner inventory", async () => {
		const diskModule = require("@core/storage/disk")
		sinon.stub(diskModule, "ensureTaskDirectoryExists").resolves("/test/task")
		const scan = sinon.stub(ToolDiscoveryService, "scanUserToolDirectory")
		scan.onFirstCall().resolves([{ ...makeTool("removed-tool"), source: "task" as const }])
		scan.onSecondCall().resolves([])

		await refreshTaskTools("task-id")
		assert.equal(ToolRegistry.getInstance().getAllTools("task-id").some((tool) => tool.id === "removed-tool"), true)
		await refreshTaskTools("task-id")
		assert.equal(ToolRegistry.getInstance().getAllTools("task-id").some((tool) => tool.id === "removed-tool"), false)
	})

})
