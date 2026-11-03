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
import { UseSubagentsTool } from "../modules/use_subagents/UseSubagentsTool"
import { ToolRegistry } from "../registry/ToolRegistry"
import { AgentConfigLoader, type AgentBaseConfig } from "../subagent/AgentConfigLoader"
import { buildSubagentToolName } from "../subagent/SubagentToolName"
import type { TaskConfig } from "../types/TaskConfig"
import type { ToolSelectionPolicy } from "./ToolSelectionPolicy"
import type { ToolRequestSnapshot } from "./ToolSnapshot"
import { ToolSnapshotManager } from "./ToolSnapshotManager"

const nonDelegatingProfiles = ["goal_coordinator", "goal_followup", "goal_child", "tasklet"] as const
const agentConfigs: AgentBaseConfig[] = ["reviewer", "implementer"].map((name) => ({
	name,
	description: `Fixture ${name}`,
	tools: ["read_file"],
	systemPrompt: `You are the fixture ${name}.`,
}))
const namedToolNames = agentConfigs.map((config) => buildSubagentToolName(config.name))
const subagentToolNames = [DiracDefaultTool.USE_SUBAGENTS, ...namedToolNames]

function nativeNames(snapshot: ToolRequestSnapshot): string[] {
	return snapshot.nativeTools.map((tool) => {
		assert.ok("name" in tool && typeof tool.name === "string", "the fixture uses Anthropic native tool schemas")
		return tool.name
	})
}

function assertGoalTools(snapshot: ToolRequestSnapshot, profile: TaskExecutionProfile): void {
	// Current discovery exposes Goal tools only to coordinators, NOT follow-ups.
	const expected = profile === "goal_coordinator" ? [...GOAL_TOOL_NAMES].sort() : []
	const goalNames = new Set<string>(GOAL_TOOL_NAMES)
	for (const names of [
		snapshot.inventoryEnabledTools.map((tool) => tool.spec.name),
		snapshot.promptVisibleSpecs.map((spec) => spec.name),
		nativeNames(snapshot),
		[...snapshot.executableToolNames],
	]) {
		assert.deepEqual(names.filter((name) => goalNames.has(name)).sort(), expected)
	}
	for (const name of GOAL_TOOL_NAMES) {
		assert.equal(snapshot.coordinator.has(name), profile === "goal_coordinator", name)
	}
}

function assertNoSubagents(snapshot: ToolRequestSnapshot): void {
	assert.equal(snapshot.inventoryEnabledTools.some((tool) => tool.id === DiracDefaultTool.USE_SUBAGENTS), false)
	assert.equal(snapshot.promptVisibleSpecs.some((spec) => spec.id === DiracDefaultTool.USE_SUBAGENTS), false)
	assert.deepEqual([...snapshot.dynamicSubagentToolNames], [])
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
) {
	const config = {
		taskId: `snapshot-${profile}`,
		ulid: `snapshot-${profile}`,
		cwd: "/goal-profile-fixture",
		executionProfile: profile,
		mode,
		subagentsEnabled: true,
		hooksEnabled: false,
		vscodeTerminalExecutionMode: "backgroundExec",
		providerId: "anthropic",
		model: { id: "fixture-model", info: {} },
		taskState: { consecutiveMistakeCount: 0 },
		services: {},
	} as TaskConfig
	const environment = {
		context: { save: sinon.stub().resolves() },
		getCustomMetadata: () => ({}),
		getCreatedCards: () => [],
	} as unknown as ToolExecutionEnvironment
	const createEnvironment = sinon.stub().returns(environment)
	const manager = new ToolSnapshotManager({
		createTaskConfig: (coordinator) => ({ ...config, coordinator }),
		getTaskId: () => config.taskId,
		getWorkspaceRoot: () => config.cwd,
		getToggles: () => ({ use_subagents: true }),
		getSelectionPolicy: () => selectionPolicy,
		getActiveSkills: () => activeSkills,
		// Same availability wiring as ToolExecutor; no mocked profile decisions.
		isToolAvailable: (tool) => isDiscoveredToolAvailableToTaskProfile(profile, tool),
		environmentFactory: { create: createEnvironment },
	})
	const context = {
		providerInfo: { providerId: config.providerId, model: config.model },
		executionProfile: profile,
		ide: "cli",
		subagentsEnabled: true,
	} as SystemPromptContext
	const snapshot = await manager.getSnapshotForRequest(context, { requestId: config.taskId, configurationRevision: 1 })
	config.coordinator = snapshot.coordinator
	config.activeToolSnapshot = snapshot
	return { snapshot, config, createEnvironment, environment }
}

describe("ToolSnapshotManager Goal and tasklet profile integration", () => {
	let configuredAgents: AgentBaseConfig[]

	beforeEach(() => {
		ToolRegistry.resetInstance()
		setHostCapabilities({})
		sinon.stub(ToolDiscoveryService, "scanGlobalUserTools").resolves([])
		sinon.stub(ToolDiscoveryService, "scanWorkspaceTools").resolves([])
		sinon.stub(UserToolLoader, "purgeStaleCache").resolves()
		sinon.stub(telemetry, "telemetryService").value({ captureToolUsage: sinon.stub() })
		configuredAgents = agentConfigs
		// Seed cached config data without filesystem/watchers; dynamic-name lookup
		// still uses the real AgentConfigLoader methods, not an availability stub.
		sinon.stub(AgentConfigLoader, "getInstance").callsFake(() => Object.assign(
			Object.create(AgentConfigLoader.prototype),
			{
				cachedConfigs: new Map(configuredAgents.map((config) => [config.name, config])),
				cachedAgentToolNames: new Map(configuredAgents.map((config) => [config.name, buildSubagentToolName(config.name)])),
				cachedToolNameToAgentName: new Map(configuredAgents.map((config) => [buildSubagentToolName(config.name), config.name])),
			},
		))
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
				const processCall = sinon.stub(UseSubagentsTool.prototype, "processCall").resolves("unexpected dispatch")
				const { snapshot, config, createEnvironment } = await createSnapshot(profile)
				assertNoSubagents(snapshot)
				assertGoalTools(snapshot, profile)
				assert.ok(snapshot.coordinator.has("read_file"), "ordinary tools remain available")
				const attemptedNames = namedAgents ? subagentToolNames : [DiracDefaultTool.USE_SUBAGENTS]
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
				// The real dispatcher is context_only, so policies cannot select it
				// as a configurable tool. Do not change its exposure for this fixture.
				assert.equal(
					ToolRegistry.getInstance().getAllTools().find((tool) => tool.id === "use_subagents")?.exposure.kind,
					"context_only",
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
				toolDependencies: [DiracDefaultTool.USE_SUBAGENTS],
			}
			await assert.rejects(createSnapshot(profile, undefined, [skill]), {
				message: `Built-in skill '${skill.name}' declares non-skill-only dependency 'use_subagents'.`,
			})
		})
	}

	it("keeps parent controls out of legacy worker allowlists", async () => {
		const tool = ToolDiscoveryService.scanBuiltinTools().find((candidate) => candidate.name === "tasklets")!
		assert.deepEqual(tool.exposure, { kind: "profile_only", profiles: ["standalone"] })
		assert.equal(ToolRegistry.getInstance().scopeToolForSubagent(tool, ["tasklets"]), undefined)
	})

	for (const profile of ["standalone", ...nonDelegatingProfiles] as const) {
		it(`${profile} exposes tasklet controls only to the owning ordinary-root profile`, async () => {
			const { snapshot, config } = await createSnapshot(profile)
			const expected = profile === "standalone"
			assert.equal(snapshot.inventoryEnabledTools.some((tool) => tool.spec.name === "tasklets"), expected)
			assert.equal(snapshot.promptVisibleSpecs.some((spec) => spec.name === "tasklets"), expected)
			assert.equal(nativeNames(snapshot).includes("tasklets"), expected)
			assert.equal(snapshot.executableToolNames.has("tasklets"), expected)
			assert.equal(snapshot.coordinator.has("tasklets"), expected)
			if (!expected) {
				await assert.rejects(snapshot.coordinator.execute(config, {
					type: "tool_use", name: "tasklets", params: { operation: "list" }, isComplete: true,
				}), { message: "No modular tool registered for: tasklets" })
			}
		})
	}

	for (const mode of ["plan", "act"] as const) {
		it(`tasklet retains ordinary work dispatch and rejects both delegation routes in ${mode} mode`, async () => {
			const readCall = sinon.stub(ReadFileTool.prototype, "processCall").resolves("fixture read")
			const delegateCall = sinon.stub(UseSubagentsTool.prototype, "processCall").resolves("unexpected dispatch")
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

	for (const namedAgents of [false, true]) {
		it(`standalone preserves ordinary inventory and dispatch with named configs ${namedAgents ? "present" : "absent"}`, async () => {
			if (!namedAgents) configuredAgents = []
			const processCall = sinon.stub(UseSubagentsTool.prototype, "processCall").resolves("fixture dispatched")
			const { snapshot, config, createEnvironment, environment } = await createSnapshot("standalone")
			const expectedVisible = namedAgents ? namedToolNames : [DiracDefaultTool.USE_SUBAGENTS]
			assert.deepEqual(
				snapshot.promptVisibleSpecs.filter((spec) => spec.id === DiracDefaultTool.USE_SUBAGENTS).map((spec) => spec.name),
				expectedVisible,
			)
			assert.deepEqual(nativeNames(snapshot).filter((name) => subagentToolNames.includes(name)), expectedVisible)
			assert.deepEqual([...snapshot.dynamicSubagentToolNames], namedAgents ? namedToolNames : [])
			assert.ok(snapshot.inventoryEnabledTools.some((tool) => tool.id === DiracDefaultTool.USE_SUBAGENTS))
			assertGoalTools(snapshot, "standalone")

			// Named configs replace generic prompt/native entries, but the generic
			// dispatcher remains executable alongside their dynamic aliases.
			const executable = namedAgents ? subagentToolNames : [DiracDefaultTool.USE_SUBAGENTS]
			for (const name of executable) {
				assert.ok(snapshot.executableToolNames.has(name), name)
				assert.ok(snapshot.coordinator.has(name), name)
				const params = name === DiracDefaultTool.USE_SUBAGENTS
					? { subagents: [{ task_title: "Fixture task", prompt: "Do the fixture task" }] }
					: { task_title: "Fixture task", prompt: "Do the fixture task" }
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
})
