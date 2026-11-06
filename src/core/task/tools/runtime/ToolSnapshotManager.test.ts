import { strict as assert } from "node:assert"
import { afterEach, beforeEach, describe, it } from "mocha"
import sinon from "sinon"
import type { SystemPromptContext } from "@core/prompts/system-prompt/types"
import { setHostCapabilities } from "@/hosts/host-capabilities"
import { diagnostics_scan_spec, DiagnosticsScanTool } from "../modules/diagnostics_scan"
import type { DiracDefaultTool, DiracToolSpec } from "@shared/tools"
import { getTaskScopedStateKey } from "@shared/taskletId"
import { ToolDiscoveryService } from "../discovery/ToolDiscoveryService"
import type { DiscoveredTool } from "../discovery/DiscoveredTool"
import { ToolRegistry } from "../registry/ToolRegistry"
import { refreshTaskTools } from "../registry/refreshToolRegistry"
import { ToolSnapshotManager } from "./ToolSnapshotManager"
import type { ToolSelectionPolicy } from "./ToolSelectionPolicy"
import type { TaskConfig } from "../types/TaskConfig"
import type { ToolExecutionEnvironment } from "../interfaces/ToolEnvironmentFactory"
import type { ToolRequestSnapshot } from "./ToolSnapshot"
import * as telemetry from "@/services/telemetry"

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
	options: Partial<ConstructorParameters<typeof ToolSnapshotManager>[0]> = {},
) {
	return new ToolSnapshotManager({
		createTaskConfig: () => ({}) as never,
		getTaskToolOwnerKey: () => taskId,
		getWorkspaceRoot: () => workspaceRoot,
		getToggles: () => toggles,
		getSelectionPolicy: () => selectionPolicy,
		getActiveSkills: () => [],
		...options,
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

	function assertToolNames(snapshot: ToolRequestSnapshot, expected: string[]) {
		assert.deepEqual(snapshot.inventoryEnabledTools.map((tool) => tool.spec.name).sort(), expected)
		assert.deepEqual(snapshot.promptVisibleSpecs.map((spec) => spec.name).sort(), expected)
		assert.deepEqual(snapshot.nativeTools.map((tool) => {
			assert.ok("name" in tool, "the fixture uses Anthropic native tools")
			return tool.name
		}).sort(), expected)
		assert.deepEqual([...snapshot.executableToolNames].sort(), expected)
		for (const name of ["alpha", "beta", "inspect_ast", "skill_tool"]) {
			assert.equal(snapshot.coordinator.has(name), expected.includes(name), name)
		}
	}

	it("leaves configured membership unchanged when allowedTools is omitted", async () => {
		const snapshot = await createManager({ alpha: true, beta: true }).getSnapshotForRequest(context, {
			requestId: "unrestricted", configurationRevision: 1,
		})
		assertToolNames(snapshot, ["alpha", "beta"])
	})

	it("restricts every request surface without enabling an allowed but disabled tool", async () => {
		const snapshot = await createManager({ alpha: true, beta: false }, "task-id", "/test-workspace", undefined, {
			allowedTools: ["beta"],
		}).getSnapshotForRequest(context, { requestId: "disabled", configurationRevision: 1 })
		assertToolNames(snapshot, [])
		await assert.rejects(snapshot.coordinator.execute({} as TaskConfig, {
			type: "tool_use", id: "disabled-beta", name: "beta", params: {}, isNativeToolCall: true,
		}), /No modular tool registered for: beta/)
	})

	it("treats an explicit empty allowedTools list as no authorized tools", async () => {
		const snapshot = await createManager({ alpha: true, beta: true }, "task-id", "/test-workspace", undefined, {
			allowedTools: [],
		}).getSnapshotForRequest(context, { requestId: "empty-scope", configurationRevision: 1 })
		assertToolNames(snapshot, [])
	})

	it("applies allowedTools after invocation selection and does not mutate unrestricted snapshots", async () => {
		const policy: ToolSelectionPolicy = { mode: "exact", toolIds: ["alpha", "beta"] }
		const restricted = await createManager({ alpha: false, beta: true }, "task-id", "/test-workspace", policy, {
			allowedTools: ["alpha"],
		}).getSnapshotForRequest(context, { requestId: "restricted", configurationRevision: 1 })
		const unrestricted = await createManager({ alpha: false, beta: true }, "task-id", "/test-workspace", policy)
			.getSnapshotForRequest(context, { requestId: "unrestricted", configurationRevision: 1 })
		assertToolNames(restricted, ["alpha"])
		assertToolNames(unrestricted, ["alpha", "beta"])
		assertToolNames(restricted, ["alpha"])
	})

	it("restricts skill-injected dependencies after activation as well as configured tools", async () => {
		ToolRegistry.getInstance().registerBuiltin({
			...makeTool("skill_tool"), exposure: { kind: "skill_only", authorizedSkillIds: ["fixture-skill"] },
		})
		for (const allowedTools of [["alpha"], ["alpha", "skill_tool"]]) {
			const snapshot = await createManager({ alpha: true, beta: true }, "task-id", "/test-workspace", undefined, {
				allowedTools,
				getActiveSkills: () => [{
					name: "fixture-skill", description: "Fixture", path: "/skills/fixture/SKILL.md", source: "builtin",
					toolDependencies: ["skill_tool"],
				}],
			}).getSnapshotForRequest(context, { requestId: allowedTools.join(","), configurationRevision: 1 })
			assert.deepEqual(snapshot.activeSkillIds, ["fixture-skill"])
			assertToolNames(snapshot, allowedTools)
		}
	})

	it("scopes operation schemas and rejects unauthorized operations through the request coordinator", async () => {
		const processCall = sinon.stub().resolves("operation executed")
		const spec = {
			...makeTool("inspect_ast").spec,
			parameters: [{ name: "operation", required: true, instruction: "AST inspection operation", enum: ["outline", "implementation"] }],
		} as DiracToolSpec
		ToolRegistry.getInstance().registerBuiltin({
			...makeTool("inspect_ast"), spec,
			factory: () => ({ spec: () => spec, supportedSurfaces: () => ["all"], processCall }),
		})
		const config = {
			taskId: "task-id", ulid: "task-id", mode: "act", hooksEnabled: false,
			vscodeTerminalExecutionMode: "backgroundExec", providerId: "anthropic",
			model: { id: "test-model", info: {} }, taskState: { consecutiveMistakeCount: 0 },
		} as TaskConfig
		const environment = {
			context: { save: sinon.stub().resolves() }, getCustomMetadata: () => ({}), getCreatedCards: () => [],
		} as unknown as ToolExecutionEnvironment
		sinon.stub(telemetry, "telemetryService").value({ captureToolUsage: sinon.stub() })
		const snapshot = await createManager({ inspect_ast: true }, "task-id", "/test-workspace", undefined, {
			allowedTools: ["inspect_ast:outline"], createTaskConfig: () => config,
			environmentFactory: { create: () => environment },
		}).getSnapshotForRequest(context, { requestId: "operations", configurationRevision: 1 })
		assertToolNames(snapshot, ["inspect_ast"])
		const scopedSpec = snapshot.promptVisibleSpecs[0]
		assert.deepEqual(scopedSpec.parameters?.find((parameter) => parameter.name === "operation")?.enum, ["outline"])
		assert.match(scopedSpec.description, /authorized only for operation: outline/)
		const native = snapshot.nativeTools[0]
		assert.ok("input_schema" in native)
		const schema = native.input_schema as { properties: Record<string, { enum: string[] }> }
		assert.deepEqual(schema.properties.operation.enum, ["outline"])
		config.activeToolSnapshot = snapshot
		for (const operation of ["outline", "implementation", undefined]) {
			const result = await snapshot.coordinator.execute(config, {
				type: "tool_use", id: `call-${operation}`, name: "inspect_ast", params: { operation }, isNativeToolCall: true,
			})
			if (operation === "outline") assert.equal(result, "operation executed")
			else assert.match(String(result), /not authorized.*Allowed operations: outline/)
		}
		sinon.assert.calledOnce(processCall)
		assert.deepEqual(processCall.firstCall.args[0], { operation: "outline" })
		assert.deepEqual(spec.parameters?.[0].enum, ["outline", "implementation"], "registry specs remain unrestricted")
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

	it("executes source/fork task tool versions independently and retains the fork after source cleanup", async () => {
		const taskId = "tasklet_00000000-0000-4000-8000-000000000001"
		const addresses = ["source", "fork"].map((rootTaskId) => ({ kind: "tasklet" as const, rootTaskId, taskletId: taskId }))
		const owners = addresses.map((address) => getTaskScopedStateKey(taskId, address))
		const diskModule = await import("@core/storage/disk")
		sinon.stub(diskModule, "ensureTaskDirectoryExists").callsFake(async (address) => {
			assert.ok(typeof address !== "string" && address.kind === "tasklet")
			return `/test/${address.rootTaskId}`
		})
		sinon.stub(ToolDiscoveryService, "scanWorkspaceTools").resolves([])
		sinon.stub(ToolDiscoveryService, "scanUserToolDirectory").callsFake(async (directory) => {
			const label = directory.includes("/fork/") ? "fork version" : "source version"
			const spec = { ...makeTool("fork-tool").spec, description: label }
			return [{
				...makeTool("fork-tool"), source: "task" as const, spec,
				modulePath: `${directory}/tool.ts`, sourceHash: label,
				factory: () => ({ spec: () => spec, supportedSurfaces: () => ["all"], processCall: async () => label }),
			}]
		})
		await Promise.all(addresses.map((address) => refreshTaskTools(taskId, address)))
		const config = {
			taskId, ulid: "copied-conversation", mode: "act", hooksEnabled: false,
			vscodeTerminalExecutionMode: "backgroundExec", providerId: "anthropic",
			model: { id: "test-model", info: {} }, taskState: { consecutiveMistakeCount: 0 },
		} as TaskConfig
		const environment = {
			context: { save: sinon.stub().resolves() }, getCustomMetadata: () => ({}), getCreatedCards: () => [],
		} as unknown as ToolExecutionEnvironment
		sinon.stub(telemetry, "telemetryService").value({ captureToolUsage: sinon.stub() })
		const managers = owners.map((owner) => createManager({}, owner, "/test-workspace", undefined, {
			createTaskConfig: () => config, environmentFactory: { create: () => environment },
		}))
		const execute = async (index: number, requestId: string) => {
			const snapshot = await managers[index].getSnapshotForRequest(context, { requestId, configurationRevision: 1 })
			assert.equal(snapshot.inventoryEnabledTools.find((tool) => tool.id === "fork-tool")?.ownerTaskId, owners[index])
			config.activeToolSnapshot = snapshot
			return snapshot.coordinator.execute(config, {
				type: "tool_use", id: requestId, name: "fork-tool", params: {}, isNativeToolCall: true,
			})
		}
		assert.equal(await execute(0, "source-request"), "source version")
		assert.equal(await execute(1, "fork-request"), "fork version")
		ToolRegistry.getInstance().removeTaskTools(owners[0])
		assert.equal(await execute(1, "fork-after-source-cleanup"), "fork version")
		assert.equal(ToolRegistry.getInstance().getAllTools(owners[0]).some((tool) => tool.source === "task"), false)
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
