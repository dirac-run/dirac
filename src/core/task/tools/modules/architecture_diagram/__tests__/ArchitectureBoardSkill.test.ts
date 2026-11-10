import { setHostCapabilities } from "@hosts/host-capabilities"
import { executeSkillCommand } from "@core/slash-commands/SkillCommandExecutor"
import { ListSkillsTool } from "../../list_skills/ListSkillsTool"
import { strict as assert } from "node:assert"
import { readFileSync } from "node:fs"
import fs from "node:fs/promises"
import * as path from "node:path"
import { BUILTIN_SKILLS, getAvailableSkills, getSkillContent } from "@core/context/instructions/user-instructions/skills"
import type { SystemPromptContext } from "@core/prompts/system-prompt/types"
import * as disk from "@core/storage/disk"
import { activateTaskSkill } from "@core/task/activateTaskSkill"
import { isSkillAvailableToTaskProfile, type TaskExecutionProfile } from "@core/task/TaskExecutionProfile"
import { TaskState } from "@core/task/TaskState"
import { ARCHITECTURE_BOARD_SKILL_NAME } from "@shared/skills"
import { afterEach, beforeEach, describe, it } from "mocha"
import sinon from "sinon"
import { buildSkillsTrait } from "../../../adapters/traits/SkillsTraitBuilder"
import type { DiscoveredTool } from "../../../discovery/DiscoveredTool"
import { ToolDiscoveryService } from "../../../discovery/ToolDiscoveryService"
import type { IToolEnvironment } from "../../../interfaces/IToolEnvironment"
import { ToolRegistry } from "../../../registry/ToolRegistry"
import { ToolSnapshotManager } from "../../../runtime/ToolSnapshotManager"
import type { TaskConfig } from "../../../types/TaskConfig"
import { UseSkillTool } from "../../use_skill/UseSkillTool"
import { create, exposure, spec } from "../tool"

const skill = BUILTIN_SKILLS.find((candidate) => candidate.name === ARCHITECTURE_BOARD_SKILL_NAME)!
const discovered: DiscoveredTool = {
	id: spec.id,
	name: spec.name,
	source: "builtin",
	exposure,
	spec,
	factory: create,
	modulePath: "modules/architecture_diagram/tool.ts",
}
const context = {
	providerInfo: { providerId: "anthropic", model: { id: "test-model", info: {} } },
	executionProfile: "standalone",
} as SystemPromptContext

function configFor(profile: TaskExecutionProfile, yolo = false): TaskConfig {
	const taskState = new TaskState()
	taskState.discoveredSkillsCache = BUILTIN_SKILLS
	return {
		executionProfile: profile,
		yoloModeToggled: yolo,
		supportsNativeWebSearch: false,
		cwd: "/unused",
		taskId: "architecture-skill-test",
		globalSkillsToggles: {},
		localSkillsToggles: {},
		taskState,
	} as TaskConfig
}

function managerFor(config: TaskConfig) {
	return new ToolSnapshotManager({
		createTaskConfig: () => config,
		getTaskToolOwnerKey: () => config.taskId,
		getWorkspaceRoot: () => undefined,
		getToggles: () => ({ architecture_diagram: true }),
		getSelectionPolicy: () => undefined,
		getActiveSkills: () =>
			config.taskState.availableSkills.filter((candidate) => config.taskState.activeSkillIds.includes(candidate.name)),
	})
}

describe("architecture-board skill integration", () => {
	beforeEach(() => {
		ToolRegistry.resetInstance()
		setHostCapabilities({ architectureViewer: { prepare: async () => { }, createPanel: async () => { throw new Error("not used") } } })
	})
	afterEach(() => {
		setHostCapabilities(undefined)
		sinon.restore()
		ToolRegistry.resetInstance()
	})

	it("is a foreground built-in with exactly one dependency and cannot be shadowed by a disk skill", () => {
		assert.ok(skill)
		assert.equal(skill.foregroundOnly, true)
		assert.notEqual(skill.interactiveOnly, true)
		assert.deepEqual(skill.toolDependencies, ["architecture_diagram"])
		const available = getAvailableSkills([{ ...skill, source: "project", foregroundOnly: false }, ...BUILTIN_SKILLS])
		assert.equal(
			available.find((candidate) => candidate.name === skill.name),
			skill,
		)
	})

	it("embeds complete instructions matching the canonical Markdown without reading disk on activation", async () => {
		const canonical = readFileSync(path.resolve("src/core/prompts/skills/architecture-board/SKILL.md"), "utf8")
			.split("---\n")
			.slice(2)
			.join("---\n")
			.trim()
		const read = sinon.stub(fs, "readFile").rejects(new Error("unexpected IO"))
		const content = await getSkillContent(skill.name, BUILTIN_SKILLS)
		assert.equal(content?.instructions, canonical)
		for (const operation of spec.parameters![0].enum) assert.ok(content!.instructions.includes(operation))
		assert.match(content!.instructions, /Current availability — Phase 5/)
		assert.match(content!.instructions, /durably saved in the owning conversation/)
		assert.match(content!.instructions, /ordinary chat does not collect unsent comments/i)
		assert.match(content!.instructions, /comments save locally/)
		assert.match(content!.instructions, /Send Feedback/)
		assert.match(content!.instructions, /Plan\/Act/)
		sinon.assert.notCalled(read)
	})

	it("requires source-backed concrete node types in the loaded skill and publication prompt", async () => {
		const content = await getSkillContent(skill.name, BUILTIN_SKILLS)
		const instructions = content!.instructions
		assert.match(instructions, /Resolve node types before publication/)
		assert.match(instructions, /inspect_ast/)
		assert.match(instructions, /exact workspace path and qualified symbol/)
		assert.match(instructions, /review each `component` at the chosen abstraction level/)
		assert.match(instructions, /unavailable or ambiguous/)
		assert.match(instructions, /does not inspect the workspace or infer types from labels/)
		assert.match(instructions, /publish a new semantic version with corrected kinds/)
		assert.match(instructions, /kind: "class", label: "ArchitectureStorage"/)
		assert.match(instructions, /kind: "function", label: "parseArchitectureDiagram"/)
		const diagramParameter = spec.parameters!.find((parameter) => parameter.name === "diagram")!
		const instruction = diagramParameter.instruction
		assert.ok(typeof instruction === "string")
		assert.match(instruction, /classes as class, functions\/methods as function/)
		assert.match(instruction, /intentional composites as component/)
		assert.match(instruction, /a composite is not an unresolved entity/)
	})

	it("preserves deliberate composites and requires meaningful labels at each abstraction level", async () => {
		const { instructions } = (await getSkillContent(skill.name, BUILTIN_SKILLS))!
		assert.match(instructions, /no goal to eliminate components or expand every overview into classes/)
		assert.match(instructions, /Meaningful labels at every level/)
		assert.match(instructions, /responsibility-based name/)
		assert.match(instructions, /preserve the actual class\/function symbol/)
		assert.match(instructions, /change of abstraction, not a correction of a misclassified class/)
		assert.match(instructions, /Use `group` when showing an enclosing boundary with visible children/)
		const publication = spec.parameters!.find((parameter) => parameter.name === "diagram")!.instruction
		assert.match(String(publication), /specific responsibility-based labels for composites/)
	})

	// These protect the loaded authoring contract, not the semantic quality of model-generated diagrams.
	it("defaults to user intent without adding a view picker or inflating the overview", async () => {
		const { instructions } = (await getSkillContent(skill.name, BUILTIN_SKILLS))!
		assert.match(instructions, /do not ask them to choose a diagram type/)
		assert.match(instructions, /Understand something/)
		assert.match(instructions, /Design \/ brainstorm \/ refine/)
		assert.match(instructions, /Review a proposal or code change/)
		assert.match(instructions, /6–12 meaningful nodes; this is a guideline, not a quota/)
		assert.match(instructions, /preserve the overview and publish a separately named detail board/)
		assert.match(instructions, /Start with one coherent proposal/)
		assert.match(instructions, /Show alternatives only when requested or/)
	})

	it("requires ownership and lifetime research beyond symbol classification", async () => {
		const { instructions } = (await getSkillContent(skill.name, BUILTIN_SKILLS))!
		assert.match(instructions, /inspect construction sites, retained fields or local variables/)
		assert.match(instructions, /Cardinality and lifetime/)
		assert.match(instructions, /Shared vs local state/)
		assert.match(instructions, /`aggregation` from owner to owned object/)
		assert.match(instructions, /only groups can be parents/)
		assert.match(instructions, /runner → owns → abort helper/)
		assert.match(instructions, /place runner \+ usage publisher inside the per-run invocation scope/)
		assert.match(instructions, /Do not portray the publisher as runner-owned/)
		assert.match(instructions, /Pre-publication semantic review/)
		assert.match(instructions, /not an automated semantic validator/)
		assert.match(instructions, /calls for a semantic revision, not just a prose explanation/)
		const publication = spec.parameters!.find((parameter) => parameter.name === "diagram")!.instruction
		assert.match(String(publication), /aggregation from owner to owned object/)
	})

	it("distinguishes comparison baselines from diagram history and implementation status", async () => {
		const { instructions } = (await getSkillContent(skill.name, BUILTIN_SKILLS))!
		assert.match(instructions, /Diagram versions are not code revisions/)
		assert.match(instructions, /inspect baseline source read-only/)
		assert.match(instructions, /same scope, abstraction level, node IDs and edge IDs/)
		assert.match(instructions, /Mark added\/modified elements on the after-side and removed elements on the before-side/)
		assert.match(instructions, /compare their exact returned versions/)
		assert.match(instructions, /Code references navigate the workspace/)
		assert.match(instructions, /do not claim synchronized layouts/)
		assert.match(instructions, /absence of `change` alone is not evidence of implementation/)
		const baseline = spec.parameters!.find((parameter) => parameter.name === "start_version")!.instruction
		assert.match(String(baseline), /inspected baseline snapshot/)
	})
	for (const profile of ["standalone", "goal_coordinator", "goal_followup", "tasklet"] as const) {
		for (const yolo of [false, true]) {
			it(`gates skill discovery/activation for ${profile}, yolo=${yolo}`, async () => {
				const config = configFor(profile, yolo)
				const trait = buildSkillsTrait(config)
				const available = await trait.getAvailableSkills()
				const expected = profile !== "tasklet"
				assert.equal(isSkillAvailableToTaskProfile(profile, skill), expected)
				assert.equal(
					available.some((candidate) => candidate.name === skill.name),
					expected,
				)
				assert.equal(Boolean(await trait.getSkillContent(skill.name, available)), expected)
			})
		}
	}

	it("discovers the lazy descriptor in the ordinary built-in barrel", () => {
		const tools = ToolDiscoveryService.scanBuiltinTools().filter((tool) => tool.id === spec.id)
		assert.equal(tools.length, 1)
		assert.deepEqual(tools[0].exposure, exposure)
		assert.equal(tools[0].spec, spec)
	})

	it("hides cached and resumed skills and tools on a host without a viewer", async () => {
		setHostCapabilities({})
		sinon.stub(ToolDiscoveryService, "scanBuiltinTools").returns([discovered])
		sinon.stub(ToolDiscoveryService, "scanGlobalUserTools").resolves([])
		const config = configFor("standalone")
		config.taskState.availableSkills = [...BUILTIN_SKILLS]
		config.taskState.activeSkillIds = [skill.name]
		const available = await buildSkillsTrait(config).getAvailableSkills()
		assert.equal(available.some((candidate) => candidate.name === skill.name), false)
		assert.equal(await getSkillContent(skill.name, BUILTIN_SKILLS), null)
		const slash = await executeSkillCommand({ commandName: skill.name } as any, "/architecture-board", "test", BUILTIN_SKILLS)
		assert.equal(slash, null)
		const card = { update: sinon.stub().resolves(), finalize: sinon.stub().resolves(), appendBody: sinon.stub().resolves() }
		const activateSkill = sinon.stub().rejects(new Error("must not activate"))
		const env = { config, skills: buildSkillsTrait(config), ui: { createCard: async () => card }, orchestration: { activateSkill, getTaskState: () => undefined, reportFailure: sinon.stub() } } as unknown as IToolEnvironment
		assert.match(await new UseSkillTool().processCall({ skill_name: skill.name }, env), /not found/)
		assert.equal((await new ListSkillsTool().processCall({}, env)).includes(skill.name), false)
		sinon.assert.notCalled(activateSkill)
		const snapshot = await managerFor(config).getSnapshotForRequest(context, { requestId: "headless-resume", configurationRevision: 1 })
		assert.deepEqual(snapshot.promptVisibleSpecs, [])
		assert.deepEqual(snapshot.nativeTools, [])
		assert.deepEqual(snapshot.activeSkillIds, [])
		assert.equal(snapshot.coordinator.has(spec.name), false)
		assert.equal(snapshot.executableToolNames.has(spec.name), false)
	})

	it("requires the tool's host capability even if resumed skill metadata lacks its requirement", async () => {
		setHostCapabilities({})
		sinon.stub(ToolDiscoveryService, "scanBuiltinTools").returns([discovered])
		sinon.stub(ToolDiscoveryService, "scanGlobalUserTools").resolves([])
		const config = configFor("standalone")
		config.taskState.availableSkills = [{ ...skill, requiredHostCapability: undefined }]
		config.taskState.activeSkillIds = [skill.name]
		const snapshot = await managerFor(config).getSnapshotForRequest(context, { requestId: "legacy-resume", configurationRevision: 1 })
		assert.deepEqual(snapshot.promptVisibleSpecs, [])
		assert.deepEqual(snapshot.nativeTools, [])
		assert.equal(snapshot.coordinator.has(spec.name), false)
	})

	it("enables one tool only on the next snapshot after persisted activation, reloads idempotently, and recovers from saved IDs", async () => {
		sinon.stub(ToolDiscoveryService, "scanBuiltinTools").returns([discovered])
		sinon.stub(ToolDiscoveryService, "scanGlobalUserTools").resolves([])
		const config = configFor("standalone")
		config.taskState.availableSkills = await buildSkillsTrait(config).getAvailableSkills()
		const manager = managerFor(config)
		const before = await manager.getSnapshotForRequest(context, { requestId: "before", configurationRevision: 1 })
		assert.deepEqual(before.promptVisibleSpecs, [])
		assert.equal(before.coordinator.has(spec.name), false)
		assert.deepEqual(ToolRegistry.getInstance().getEnabledTools(), [])
		assert.deepEqual(ToolRegistry.getInstance().getConfigurableTools(), [])

		const metadata = { active_skill_ids: [] as string[] }
		const persist = sinon.stub(disk, "updateTaskMetadata").callsFake(async (_id, mutate) => {
			mutate(metadata as any)
			return metadata as any
		})
		const card = { update: sinon.stub().resolves(), finalize: sinon.stub().resolves() }
		const env = {
			config,
			ui: { createCard: sinon.stub().resolves(card) },
			skills: { ...buildSkillsTrait(config), listSupportingFiles: async () => ({ docs: [], scripts: [] }) },
			orchestration: {
				getTaskState: (key: string) => key === "activeSkillIds" ? config.taskState.activeSkillIds : undefined,
				reportFailure: sinon.stub(),
				activateSkill: (id: string) => activateTaskSkill(config.taskId, config.taskState, id),
			},
			telemetry: { captureCustomMetadata: sinon.stub() },
		} as unknown as IToolEnvironment
		Object.defineProperty(env, "architecture", {
			get: () => {
				throw new Error("Skill activation must not access board storage")
			},
		})
		const useSkill = new UseSkillTool()
		assert.match(await useSkill.processCall({ skill_name: skill.name }, env), /is now active/)
		assert.deepEqual(metadata.active_skill_ids, [skill.name])
		const after = await manager.getSnapshotForRequest(context, { requestId: "after", configurationRevision: 1 })
		assert.deepEqual(after.promptVisibleSpecs, [spec])
		assert.equal(after.nativeTools.length, 1)
		assert.equal(after.coordinator.has(spec.name), true)
		assert.deepEqual(before.promptVisibleSpecs, [])
		assert.match(await useSkill.processCall({ skill_name: skill.name }, env), /already active/)
		sinon.assert.calledOnce(persist)

		const restored = configFor("goal_followup", true)
		restored.taskState.availableSkills = await buildSkillsTrait(restored).getAvailableSkills()
		restored.taskState.activeSkillIds = JSON.parse(JSON.stringify(metadata.active_skill_ids))
		const recovered = await managerFor(restored).getSnapshotForRequest(context, {
			requestId: "restored",
			configurationRevision: 2,
		})
		assert.deepEqual(recovered.promptVisibleSpecs, [spec])
		assert.deepEqual(recovered.activeSkillIds, [skill.name])

		const worker = configFor("tasklet")
		worker.taskState.availableSkills = await buildSkillsTrait(worker).getAvailableSkills()
		worker.taskState.activeSkillIds = [...metadata.active_skill_ids]
		const privateSnapshot = await managerFor(worker).getSnapshotForRequest(context, {
			requestId: "private",
			configurationRevision: 1,
		})
		assert.deepEqual(privateSnapshot.promptVisibleSpecs, [])
		assert.deepEqual(privateSnapshot.activeSkillIds, [])

	})
})
