import { strict as assert } from "node:assert"
import { describe, it } from "mocha"
import {
	assertTaskMutationAuthorized,
	bindToolSnapshotToRequestRuntime,
	createTaskRequestRuntime,
	isTaskMutationAuthorized,
	TaskMutationGate,
} from "./TaskRequestRuntime"
import { createTaskWorkingConfiguration } from "./TaskWorkingConfiguration"

function configuration(mode: "plan" | "act" = "plan") {
	return createTaskWorkingConfiguration({
		settings: { mode, strictPlanModeEnabled: true } as any,
		apiConfiguration: {},
		workspaceConfiguration: {} as any,
		executionOptions: {
			terminalReuseEnabled: true,
			vscodeTerminalExecutionMode: "vscodeTerminal",
			multiRootEnabled: false,
		},
	})
}

describe("TaskRequestRuntime", () => {
	it("binds one request identity and configuration revision to its tool snapshot", () => {
		const runtime = createTaskRequestRuntime(configuration(), {} as any, "request-1")
		const snapshot = {
			inventoryVersion: 1,
			requestId: "request-1",
			configurationRevision: 1,
			promptVisibleSpecs: [],
			inventoryEnabledTools: [],
			activeSkillIds: [],
			nativeTools: [],
			coordinator: {} as any,
			executableToolNames: new Set<string>(),
		}
		const bound = bindToolSnapshotToRequestRuntime(runtime, snapshot)
		assert.equal(bound.toolSnapshot, snapshot)
		assert.equal(bound.workingConfiguration.settings.mode, "plan")
		assert.ok(Object.isFrozen(bound))
	})

	it("rejects a snapshot from another request or revision", () => {
		const runtime = createTaskRequestRuntime(configuration(), {} as any, "request-1")
		const snapshot = {
			inventoryVersion: 1,
			requestId: "request-2",
			configurationRevision: 1,
			promptVisibleSpecs: [],
			inventoryEnabledTools: [],
			activeSkillIds: [],
			nativeTools: [],
			coordinator: {} as any,
			executableToolNames: new Set<string>(),
		}
		assert.throws(() => bindToolSnapshotToRequestRuntime(runtime, snapshot), /identity mismatch/)
		assert.throws(
			() => bindToolSnapshotToRequestRuntime(runtime, { ...snapshot, requestId: "request-1", configurationRevision: 2 }),
			/revision mismatch/,
		)
	})

	it("never grants an old Plan request mutation after Plan-to-Act", () => {
		assert.equal(isTaskMutationAuthorized(configuration("plan"), configuration("act")), false)
		assert.throws(
			() => assertTaskMutationAuthorized(configuration("plan"), configuration("act"), "edit_file"),
			/Plan Mode does not permit file mutations/,
		)
	})

	it("preserves Plan mutations when strict Plan mode is disabled", () => {
		const planWithoutStrictMode = createTaskWorkingConfiguration({
			settings: { mode: "plan", strictPlanModeEnabled: false } as any,
			apiConfiguration: {},
			workspaceConfiguration: {} as any,
			executionOptions: {
				terminalReuseEnabled: true,
				vscodeTerminalExecutionMode: "vscodeTerminal",
				multiRootEnabled: false,
			},
		})
		assert.equal(isTaskMutationAuthorized(planWithoutStrictMode, planWithoutStrictMode), true)
	})

	it("revokes an old Act request after Act-to-Plan", () => {
		assert.equal(isTaskMutationAuthorized(configuration("act"), configuration("plan")), false)
	})

	it("keeps an Act request authorized across unrelated configuration revisions", () => {
		const requestConfiguration = configuration("act")
		const currentConfiguration = {
			...configuration("act"),
			revision: requestConfiguration.revision + 1,
		}
		assert.equal(isTaskMutationAuthorized(requestConfiguration, currentConfiguration), true)
	})

	it("waits for an in-flight mutation before committing a transition", async () => {
		const gate = new TaskMutationGate()
		let releaseMutation!: () => void
		const mutationPaused = new Promise<void>((resolve) => {
			releaseMutation = resolve
		})
		const events: string[] = []
		const mutation = gate.withMutation(
			() => events.push("authorized"),
			async () => {
				events.push("mutation-start")
				await mutationPaused
				events.push("mutation-end")
			},
		)
		await Promise.resolve()
		const transition = gate.withTransition(async () => {
			events.push("transition")
		})
		await Promise.resolve()
		assert.deepEqual(events, ["authorized", "mutation-start"])
		releaseMutation()
		await Promise.all([mutation, transition])
		assert.deepEqual(events, ["authorized", "mutation-start", "mutation-end", "transition"])
	})
	it("allows a nested mutation lease to finish before a queued transition", async () => {
		const gate = new TaskMutationGate()
		let startNested!: () => void
		const nestedReady = new Promise<void>((resolve) => {
			startNested = resolve
		})
		let outerStarted!: () => void
		const outerReady = new Promise<void>((resolve) => {
			outerStarted = resolve
		})
		const events: string[] = []
		const outer = gate.withMutation(
			() => events.push("outer-authorized"),
			async () => {
				events.push("outer-start")
				outerStarted()
				await nestedReady
				await gate.withMutation(
					() => events.push("nested-authorized"),
					async () => {
						events.push("nested")
					},
				)
				events.push("outer-end")
			},
		)
		await outerReady
		const transition = gate.withTransition(() => events.push("transition"))
		await Promise.resolve()
		startNested()
		await Promise.all([outer, transition])
		assert.deepEqual(events, [
			"outer-authorized",
			"outer-start",
			"nested-authorized",
			"nested",
			"outer-end",
			"transition",
		])
	})
	it("hands an active mutation directly to its follow-up transition", async () => {
		const gate = new TaskMutationGate()
		let allowHandoff!: () => void
		const handoffReady = new Promise<void>((resolve) => {
			allowHandoff = resolve
		})
		let mutationStarted!: () => void
		const mutationReady = new Promise<void>((resolve) => {
			mutationStarted = resolve
		})
		const events: string[] = []
		const mutation = gate.withMutation(
			() => events.push("authorized"),
			async () => {
				events.push("mutation")
				mutationStarted()
				await handoffReady
				await gate.transitionFromMutation(async () => {
					events.push("handoff-transition")
					await gate.withTransition(() => events.push("nested-transition"))
				})
			},
		)
		await mutationReady
		const queuedTransition = gate.withTransition(() => events.push("queued-transition"))
		await Promise.resolve()
		allowHandoff()
		await Promise.all([mutation, queuedTransition])
		assert.deepEqual(events, [
			"authorized",
			"mutation",
			"handoff-transition",
			"nested-transition",
			"queued-transition",
		])
	})



	it("keeps transitions waiting after a background mutation is detached", async () => {
		const gate = new TaskMutationGate()
		let completeBackground!: () => void
		const backgroundCompletion = new Promise<void>((resolve) => {
			completeBackground = resolve
		})
		const events: string[] = []
		await gate.withMutation(
			() => events.push("authorized"),
			async () => {
				events.push("command-returned")
				gate.retainMutationUntil(backgroundCompletion)
			},
		)
		const transition = gate.withTransition(() => events.push("transition"))
		await Promise.resolve()
		assert.deepEqual(events, ["authorized", "command-returned"])
		completeBackground()
		await transition
		assert.deepEqual(events, ["authorized", "command-returned", "transition"])
	})


	it("rechecks authorization after a queued transition before starting a late mutation", async () => {
		const gate = new TaskMutationGate()
		let releaseFirst!: () => void
		const firstPaused = new Promise<void>((resolve) => {
			releaseFirst = resolve
		})
		let currentMode: "act" | "plan" = "act"
		const first = gate.withMutation(() => undefined, async () => await firstPaused)
		await Promise.resolve()
		const transition = gate.withTransition(() => {
			currentMode = "plan"
		})
		const lateMutation = assert.rejects(
			gate.withMutation(
				() => {
					if (currentMode === "plan") throw new Error("revoked")
				},
				async () => undefined,
			),
			/revoked/,
		)
		releaseFirst()
		await first
		await transition
		await lateMutation
	})
})
