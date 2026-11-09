import { strict as assert } from "node:assert"
import { afterEach, beforeEach, describe, it } from "mocha"
import sinon from "sinon"
import { BUILTIN_SKILLS } from "@core/context/instructions/user-instructions/skills"
import type { SystemPromptContext } from "@core/prompts/system-prompt/types"
import { setHostCapabilities } from "@hosts/host-capabilities"
import * as telemetry from "@/services/telemetry"
import type { SkillMetadata } from "@shared/skills"
import { DiracDefaultTool } from "@shared/tools"
import {
	GOAL_TOOL_NAMES,
	isDiscoveredToolAvailableToTaskProfile,
	type TaskExecutionProfile,
} from "../../TaskExecutionProfile"
import { ToolDiscoveryService } from "../discovery/ToolDiscoveryService"
import { UserToolLoader } from "../discovery/UserToolLoader"
import type { ToolExecutionEnvironment } from "../interfaces/ToolEnvironmentFactory"
import { ReadFileTool } from "../modules/read_file/ReadFileTool"
import { SubagentsTool } from "../modules/subagents/SubagentsTool"
import { ToolRegistry } from "../registry/ToolRegistry"
import type { TaskConfig } from "../types/TaskConfig"
import type { ToolSelectionPolicy } from "./ToolSelectionPolicy"
import type { ToolRequestSnapshot } from "./ToolSnapshot"
import { ToolSnapshotManager } from "./ToolSnapshotManager"

const rootProfiles = ["standalone", "goal_coordinator", "goal_followup"] as const
const nonDelegatingProfiles = ["tasklet"] as const
const retiredGoalTools = ["verify_goal", "start_task", "list_tasks", "send_task_message", "cancel_task", "read_task_transcript", "resolve_task_interaction", "wait_for_goal_events"]
const agentConfigs = ["reviewer", "implementer"].map((name) => ({ name, description: `Fixture ${name}` }))
const namedToolNames = ["use_subagent_reviewer", "use_subagent_implementer"]
const subagentToolNames = [DiracDefaultTool.SUBAGENTS, ...namedToolNames]
let configuredAgents = agentConfigs

function nativeNames(snapshot: ToolRequestSnapshot): string[] {
	return snapshot.nativeTools.map((tool) => {
		assert.ok("name" in tool && typeof tool.name === "string", "the fixture uses Anthropic native tool schemas")
		return tool.name
	})
}

function assertGoalTools(snapshot: ToolRequestSnapshot, profile: TaskExecutionProfile): void {
	const goalRoot = profile === "goal_coordinator" || profile === "goal_followup"
	const expected = goalRoot ? [...GOAL_TOOL_NAMES].sort() : []
	const goalNames = new Set<string>(GOAL_TOOL_NAMES)
	for (const names of [
		snapshot.inventoryEnabledTools.map((tool) => tool.spec.name),
		snapshot.promptVisibleSpecs.map((spec) => spec.name),
		nativeNames(snapshot),
		[...snapshot.executableToolNames],
	]) {
		assert.deepEqual(names.filter((name) => goalNames.has(name)).sort(), expected)
		assert.deepEqual(names.filter((name) => retiredGoalTools.includes(name)), [])
	}
	for (const name of GOAL_TOOL_NAMES) {
		assert.equal(snapshot.coordinator.has(name), goalRoot, name)
	}
}

function assertNoSubagents(snapshot: ToolRequestSnapshot): void {
	assert.equal(snapshot.inventoryEnabledTools.some((tool) => tool.id === DiracDefaultTool.SUBAGENTS), false)
	assert.equal(snapshot.promptVisibleSpecs.some((spec) => spec.id === DiracDefaultTool.SUBAGENTS), false)
	for (const name of subagentToolNames) {
		assert.equal(snapshot.inventoryEnabledTools.some((tool) => tool.spec.name === name), false, name)
		assert.equal(snapshot.promptVisibleSpecs.some((spec) => spec.name === name), false, name)
		assert.equal(nativeNames(snapshot).includes(name), false, name)
		assert.equal(snapshot.executableToolNames.has(name), false, name)
		assert.equal(snapshot.coordinator.has(name), false, name)
	}
}

async function createSnapshot(
	profile: TaskExecutionProfile,
	selectionPolicy?: ToolSelectionPolicy,
	activeSkills: readonly SkillMetadata[] = [],
	mode: TaskConfig["mode"] = "act",
	subagentsEnabled = true,
) {
	const config = {
		taskId: `snapshot-${profile}`,
		ulid: `snapshot-${profile}`,
		cwd: "/goal-profile-fixture",
		executionProfile: profile,
		mode,
		subagentsEnabled,
		hooksEnabled: false,
		vscodeTerminalExecutionMode: "backgroundExec",
		providerId: "anthropic",
		model: { id: "fixture-model", info: {} },
		taskState: { consecutiveMistakeCount: 0 },
		services: {},
	} as TaskConfig
	const environment = {
		config,
		context: { save: sinon.stub().resolves() },
		getCustomMetadata: () => ({}),
		getCreatedCards: () => [],
	} as unknown as ToolExecutionEnvironment
	const createEnvironment = sinon.stub().returns(environment)
	const manager = new ToolSnapshotManager({
		createTaskConfig: (coordinator) => ({ ...config, coordinator }),
		getTaskToolOwnerKey: () => config.taskId,
		getWorkspaceRoot: () => config.cwd,
		getToggles: () => ({ subagents: true }),
		getSelectionPolicy: () => selectionPolicy,
		getActiveSkills: () => activeSkills,
		// Same availability wiring as ToolExecutor; no mocked profile decisions.
		isToolAvailable: (tool) => isDiscoveredToolAvailableToTaskProfile(profile, tool),
		environmentFactory: { create: createEnvironment },
	})
	const context = {
		providerInfo: { providerId: config.providerId, model: config.model, mode: config.mode },
		executionProfile: profile,
		ide: "cli",
		subagentsEnabled,
		subagentRoles: configuredAgents,
	} as SystemPromptContext
	const snapshot = await manager.getSnapshotForRequest(context, { requestId: config.taskId, configurationRevision: 1 })
	config.coordinator = snapshot.coordinator
	config.activeToolSnapshot = snapshot
	return { snapshot, config, createEnvironment, environment }
}

describe("ToolSnapshotManager Goal and tasklet profile integration", () => {

	beforeEach(() => {
		ToolRegistry.resetInstance()
		setHostCapabilities({})
		sinon.stub(ToolDiscoveryService, "scanGlobalUserTools").resolves([])
		sinon.stub(ToolDiscoveryService, "scanWorkspaceTools").resolves([])
		sinon.stub(UserToolLoader, "purgeStaleCache").resolves()
		sinon.stub(telemetry, "telemetryService").value({ captureToolUsage: sinon.stub() })
		configuredAgents = agentConfigs
	})

	afterEach(() => {
		sinon.restore()
		ToolRegistry.resetInstance()
		setHostCapabilities(undefined)
	})

	for (const profile of nonDelegatingProfiles) {
		for (const namedAgents of [false, true]) {
			it(`${profile} excludes and rejects subagents with named configs ${namedAgents ? "present" : "absent"}`, async () => {
				if (!namedAgents) configuredAgents = []
				const processCall = sinon.stub(SubagentsTool.prototype, "processCall").resolves("unexpected dispatch")
				const { snapshot, config, createEnvironment } = await createSnapshot(profile)
				assertNoSubagents(snapshot)
				assertGoalTools(snapshot, profile)
				assert.ok(snapshot.coordinator.has("read_file"), "ordinary tools remain available")
				const attemptedNames = namedAgents ? subagentToolNames : [DiracDefaultTool.SUBAGENTS]
				for (const name of attemptedNames) {
					await assert.rejects(
						snapshot.coordinator.execute(config, { type: "tool_use", name, params: {}, isComplete: true }),
						{ message: `No modular tool registered for: ${name}` },
					)
				}
				sinon.assert.notCalled(processCall)
				sinon.assert.notCalled(createEnvironment)
			})
		}

		for (const mode of ["exact", "delta"] as const) {
			it(`${profile} cannot select subagents back in with selection mode ${mode}`, async () => {
				const requested = ["read_file", ...subagentToolNames]
				const policy: ToolSelectionPolicy = mode === "exact"
					? { mode, toolIds: requested }
					: { mode, enabledToolIds: requested, disabledToolIds: [] }
				const { snapshot } = await createSnapshot(profile, policy)
				assertNoSubagents(snapshot)
				assertGoalTools(snapshot, profile)
				assert.ok(snapshot.executableToolNames.has("read_file"))
				// Profile-only supervision cannot be selected back into a child.
				assert.equal(
					ToolRegistry.getInstance().getAllTools().find((tool) => tool.id === "subagents")?.exposure.kind,
					"profile_only",
				)
			})
		}

		it(`${profile} retains active built-in skill dependencies without restoring subagents`, async () => {
			const skill = BUILTIN_SKILLS.find((candidate) => candidate.name === "new-tool")!
			assert.ok(skill)
			const { snapshot } = await createSnapshot(profile, { mode: "exact", toolIds: [] }, [skill])
			assert.deepEqual(snapshot.activeSkillIds, [skill.name])
			for (const name of skill.toolDependencies!) {
				assert.ok(snapshot.inventoryEnabledTools.some((tool) => tool.spec.name === name))
				assert.ok(snapshot.promptVisibleSpecs.some((spec) => spec.name === name))
				assert.ok(nativeNames(snapshot).includes(name))
				assert.ok(snapshot.executableToolNames.has(name))
				assert.ok(snapshot.coordinator.has(name))
			}
			assertNoSubagents(snapshot)
			assertGoalTools(snapshot, profile)
		})

		it(`${profile} rejects a built-in skill attempting to depend on the dispatcher`, async () => {
			const skill: SkillMetadata = {
				name: "subagent-dependency-fixture",
				description: "Invalid built-in dependency fixture",
				path: "<builtin>/subagent-dependency-fixture/SKILL.md",
				source: "builtin",
				toolDependencies: [DiracDefaultTool.SUBAGENTS],
			}
			await assert.rejects(createSnapshot(profile, undefined, [skill]), {
				message: `Built-in skill '${skill.name}' declares non-skill-only dependency 'subagents'.`,
			})
		})
	}


	for (const profile of [...rootProfiles, ...nonDelegatingProfiles] as const) {
		it(`${profile} exposes tasklet controls only to root profiles`, async () => {
			const { snapshot, config } = await createSnapshot(profile)
			const expected = profile !== "tasklet"
			assert.equal(snapshot.inventoryEnabledTools.some((tool) => tool.spec.name === "subagents"), expected)
			assert.equal(snapshot.promptVisibleSpecs.some((spec) => spec.name === "subagents"), expected)
			assert.equal(nativeNames(snapshot).includes("subagents"), expected)
			assert.equal(snapshot.executableToolNames.has("subagents"), expected)
			assert.equal(snapshot.coordinator.has("subagents"), expected)
			assert.equal(snapshot.inventoryEnabledTools.some((tool) => tool.spec.name === "tasklets"), false)
			assert.equal(nativeNames(snapshot).includes("tasklets"), false)
			assert.equal(snapshot.executableToolNames.has("tasklets"), false)
			await assert.rejects(snapshot.coordinator.execute(config, {
				type: "tool_use", name: "tasklets", params: { operation: "list" }, isComplete: true,
			}), { message: "No modular tool registered for: tasklets" })
		})
	}

	for (const mode of ["plan", "act"] as const) {
		it(`tasklet retains ordinary work dispatch and rejects both delegation routes in ${mode} mode`, async () => {
			const readCall = sinon.stub(ReadFileTool.prototype, "processCall").resolves("fixture read")
			const delegateCall = sinon.stub(SubagentsTool.prototype, "processCall").resolves("unexpected dispatch")
			const { snapshot, config, environment } = await createSnapshot("tasklet", undefined, [], mode)
			assert.equal(config.mode, mode)
			assertNoSubagents(snapshot)
			assert.equal(snapshot.coordinator.has("tasklets"), false)
			for (const name of ["read_file", "edit_file", "execute_command", "write_to_file", "respond"]) {
				assert.ok(snapshot.executableToolNames.has(name), name)
			}
			const params = { paths: ["fixture.txt"] }
			assert.equal(await snapshot.coordinator.execute(config, {
				type: "tool_use", name: "read_file", params, isComplete: true,
			}), "fixture read")
			sinon.assert.calledOnceWithExactly(readCall, params, environment)
			for (const name of subagentToolNames) {
				await assert.rejects(snapshot.coordinator.execute(config, {
					type: "tool_use", name, params: {}, isComplete: true,
				}), { message: `No modular tool registered for: ${name}` })
			}
			sinon.assert.notCalled(delegateCall)
		})
	}

	for (const profile of rootProfiles) {
		for (const namedAgents of [false, true]) {
			it(`${profile} disables generic and named spawning, not retained controls, when subagents are disabled (${namedAgents ? "named" : "generic"})`, async () => {
				if (!namedAgents) configuredAgents = []
				const { snapshot, config, environment } = await createSnapshot(profile, undefined, [], "act", false)
				assertGoalTools(snapshot, profile)
				assert.ok(snapshot.coordinator.has("subagents"), "existing children remain controllable")
				const list = sinon.stub().returns({ items: [], totalItems: 0 })
				const start = sinon.stub()
				Object.assign(environment, {
					orchestration: { tasklets: { list, start } },
					ui: { createCard: async () => ({ id: "control-card", update: async () => undefined, finalize: async () => undefined }) },
				})
				const result = await snapshot.coordinator.execute(config, { type: "tool_use", name: "subagents", params: { operation: "create", assignments: [{ type: "default", task_header: "Blocked", task_description: "Blocked" }] }, isComplete: true })
				assert.match(result as string, /Subagent creation is disabled/)
				sinon.assert.notCalled(start)
				await snapshot.coordinator.execute(config, { type: "tool_use", name: "subagents", params: { operation: "list" }, isComplete: true })
				sinon.assert.calledOnce(list)
				for (const name of namedToolNames) {
					await assert.rejects(snapshot.coordinator.execute(config, { type: "tool_use", name, params: {}, isComplete: true }), {
						message: `No modular tool registered for: ${name}`,
					})
				}
			})
		}
	}

	for (const profile of ["goal_coordinator", "goal_followup"] as const) {
		it(`${profile} dispatches real shared spawn/list/resume tools through the environment`, async () => {
			configuredAgents = []
			const { snapshot, config, environment } = await createSnapshot(profile)
			const tasklet = { id: "tasklet_stable", title: "Inspect", rootTaskId: config.taskId, conversationUlid: "child-conversation", prompt: "Inspect it", createdAt: 1 }
			const start = sinon.stub().resolves(tasklet)
			const list = sinon.stub().returns([{ ...tasklet, status: "completed" }])
			const resume = sinon.stub().resolves(tasklet)
			Object.assign(environment, {
				toolName: "subagents",
				orchestration: { tasklets: { start, list, resume } },
				ui: { createCard: async () => ({ id: "tool-card", update: async () => undefined, finalize: async () => undefined }) },
			})
			const spawnParams = { operation: "create", assignments: [{ type: "default", task_header: "Inspect", task_description: "Inspect it" }] }
			const spawned = await snapshot.coordinator.execute(config, { type: "tool_use", name: "subagents", params: spawnParams, isComplete: true })
			assert.deepEqual(JSON.parse(spawned as string).subagents, [{ index: 0, id: tasklet.id, title: "Inspect", accepted: true }])
			sinon.assert.calledOnceWithExactly(start, { title: "Inspect", prompt: "Inspect it", type: "default" })
			const listed = await snapshot.coordinator.execute(config, { type: "tool_use", name: "subagents", params: { operation: "list" }, isComplete: true })
			assert.equal(JSON.parse(listed as string)[0].id, tasklet.id)
			const resumed = await snapshot.coordinator.execute(config, { type: "tool_use", name: "subagents", params: { operation: "resume", tasklet_id: tasklet.id, message: "Continue" }, isComplete: true })
			assert.equal(JSON.parse(resumed as string).id, tasklet.id)
			sinon.assert.calledOnceWithExactly(resume, tasklet.id, "Continue")
			for (const name of retiredGoalTools) {
				await assert.rejects(snapshot.coordinator.execute(config, { type: "tool_use", name, params: {}, isComplete: true }), { message: `No modular tool registered for: ${name}` })
			}
		})
	}

	for (const profile of rootProfiles) {
		for (const namedAgents of [false, true]) {
			it(`${profile} preserves shared inventory and dispatch with named configs ${namedAgents ? "present" : "absent"}`, async () => {
				if (!namedAgents) configuredAgents = []
				const processCall = sinon.stub(SubagentsTool.prototype, "processCall").resolves("fixture dispatched")
				const { snapshot, config, createEnvironment, environment } = await createSnapshot(profile)
				const expectedVisible = [DiracDefaultTool.SUBAGENTS]
				assert.deepEqual(
					snapshot.promptVisibleSpecs.filter((spec) => spec.id === DiracDefaultTool.SUBAGENTS).map((spec) => spec.name),
					expectedVisible,
				)
				assert.deepEqual(nativeNames(snapshot).filter((name) => subagentToolNames.includes(name)), expectedVisible)
				assert.ok(snapshot.inventoryEnabledTools.some((tool) => tool.id === DiracDefaultTool.SUBAGENTS))
				assertGoalTools(snapshot, profile)
				const creation = snapshot.promptVisibleSpecs.find((spec) => spec.name === "subagents")!
				assert.deepEqual(creation.parameters!.find((parameter) => parameter.name === "assignments")!.items.properties.type.enum, ["default", ...configuredAgents.map((role) => role.name)])
				for (const retiredName of namedToolNames) {
					assert.equal(snapshot.coordinator.has(retiredName), false)
					assert.equal(snapshot.executableToolNames.has(retiredName), false)
				}

				const executable = [DiracDefaultTool.SUBAGENTS]
				for (const name of executable) {
					assert.ok(snapshot.executableToolNames.has(name), name)
					assert.ok(snapshot.coordinator.has(name), name)
					const params = { operation: "create", assignments: [{ type: "default", task_header: "Fixture task", task_description: "Do the fixture task" }] }
					assert.equal(
						await snapshot.coordinator.execute(config, { type: "tool_use", name, params, isComplete: true }),
						"fixture dispatched",
					)
					sinon.assert.calledWithExactly(processCall, params, environment)
				}
				sinon.assert.callCount(processCall, executable.length)
				sinon.assert.callCount(createEnvironment, executable.length)
			})
		}
	}
})
