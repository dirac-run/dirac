import assert from "node:assert/strict"
import { describe, it } from "mocha"
import sinon from "sinon"
import { CardStatus } from "@shared/ExtensionMessage"
import { DiracAskResponse } from "@shared/WebviewMessage"
import type { TaskConfig } from "../../types/TaskConfig"
import type { CardParams } from "../../interfaces/ICardHandle"
import { createCardFromMessenger } from "../traits/UiTraitBuilder"

function fixture(child = false) {
	const cancellation = new AbortController()
	const decide = sinon.stub().resolves({ decision: "approve", reason: "Allowed by policy" })
	let finishPublication!: () => void
	const publication = new Promise<void>((resolve) => { finishPublication = resolve })
	let startPublication!: () => void
	const publicationStarted = new Promise<void>((resolve) => { startPublication = resolve })
	const waitForInteraction = sinon.stub().resolves({ action: DiracAskResponse.REJECT, response: DiracAskResponse.REJECT })
	const createCard = sinon.stub().callsFake(async (params: CardParams) => {
		if (params.toolName === "permission_approval") {
			startPublication()
			await publication
		}
		return {
			id: "card",
			getCard: () => ({ ...params, id: "card", status: params.status ?? CardStatus.WAITING_FOR_INPUT }),
			waitForInteraction,
		}
	})
	const config = {
		executionProfile: child ? "tasklet" : "standalone",
		cwd: "/workspace",
		mode: "act",
		yoloModeToggled: false,
		toolUse: { name: "execute_command", params: { commands: ["python tool.py"] } },
		taskState: { abortSignal: cancellation.signal },
		taskMessenger: { routesToOwner: child, createCard },
		autoApprover: { isUnrestrictedAutoApprove: sinon.stub().returns(false) },
		permissionDecisionBinding: { authorityMode: "act", configurationRevision: 1, commandPermissionRevision: 0, service: { decide } },
	} as unknown as TaskConfig
	const params: CardParams = {
		header: "Execute script",
		requireApproval: true,
		permissionRequestKind: "tool",
		permissionOperation: { kind: "commands", commands: ["@root:python tool.py"] },
	}
	return { config, params, decide, createCard, cancellation, publicationStarted, finishPublication, waitForInteraction }
}

describe("Root Utility approval publication", () => {
	for (const child of [false, true]) {
		it(`includes immutable resolved cwd for every command in ${child ? "child" : "root"} Utility evaluation`, async () => {
			const h = fixture(child)
			h.config.toolUse = { name: "execute_command", params: { commands: ["python clean.py", "@secondary:npm run clean"] } }
			const executionContexts = [
				{ command: "python clean.py", cwd: "/workspace" },
				{ command: "npm run clean", cwd: "/sensitive/secondary" },
			]
			h.params.permissionOperation = {
				kind: "commands", commands: executionContexts.map(({ command }) => command), executionContexts,
			}
			const expected = structuredClone(h.params.permissionOperation)
			const pendingCard = createCardFromMessenger(h.config, h.params, [])
			await h.publicationStarted
			executionContexts[1].cwd = "/changed/after-evaluation"
			h.finishPublication()

			assert.equal((await (await pendingCard).waitForInteraction()).action, DiracAskResponse.APPROVE)
			assert.deepEqual(h.decide.firstCall.args[0].permission.operation, expected)
			assert.equal(h.decide.firstCall.args[0].runtime.cwd, "/workspace")
		})
	}

	it("approves without manual interaction when authority stays unchanged during publication", async () => {
		const h = fixture()
		const pendingCard = createCardFromMessenger(h.config, h.params, [])
		await h.publicationStarted
		h.finishPublication()

		const card = await pendingCard
		assert.equal((await card.waitForInteraction()).action, DiracAskResponse.APPROVE)
		sinon.assert.calledOnce(h.decide)
		sinon.assert.calledOnce(h.createCard)
		sinon.assert.notCalled(h.waitForInteraction)
		assert.equal(h.createCard.firstCall.args[0].header, "Dirac · Auto-approved")
	})

	for (const change of ["configuration", "command permissions", "disabled"] as const) {
		it(`falls back to manual approval after a ${change} update during publication`, async () => {
			const h = fixture()
			const pendingCard = createCardFromMessenger(h.config, h.params, [])
			await h.publicationStarted
			const binding = h.config.permissionDecisionBinding!
			h.config.permissionDecisionBinding = change === "disabled" ? undefined : {
				...binding,
				authorityMode: change === "configuration" ? "plan" : binding.authorityMode,
				configurationRevision: binding.configurationRevision + (change === "configuration" ? 1 : 0),
				commandPermissionRevision: (binding.commandPermissionRevision ?? 0) + (change === "command permissions" ? 1 : 0),
			}
			h.finishPublication()

			const card = await pendingCard
			assert.equal(card.requiresUserInteraction, true)
			assert.equal((await card.waitForInteraction()).action, DiracAskResponse.REJECT)
			sinon.assert.calledOnce(h.decide)
			sinon.assert.calledTwice(h.createCard)
			sinon.assert.calledOnce(h.waitForInteraction)
			assert.equal(h.createCard.secondCall.args[0].requireApproval, true)
			assert.deepEqual(h.createCard.secondCall.args[0].permissionOperation, h.params.permissionOperation)
		})
	}

	it("aborts before publication after cancellation during evaluation", async () => {
		const h = fixture()
		h.decide.callsFake(async () => {
			h.cancellation.abort()
			return { decision: "approve", reason: "Allowed by policy" }
		})

		await assert.rejects(createCardFromMessenger(h.config, h.params, []), /abort/i)
		sinon.assert.notCalled(h.createCard)
		sinon.assert.notCalled(h.waitForInteraction)
	})

	it("aborts instead of returning approval or requesting manual interaction after cancellation during publication", async () => {
		const h = fixture()
		const pendingCard = createCardFromMessenger(h.config, h.params, [])
		await h.publicationStarted
		h.cancellation.abort()
		h.finishPublication()

		await assert.rejects(pendingCard, /abort/i)
		sinon.assert.calledOnce(h.createCard)
		sinon.assert.notCalled(h.waitForInteraction)
	})
	for (const child of [false, true]) {
		for (const phase of ["evaluation", "publication"] as const) {
			it(`uses execution cancellation during ${phase} in ${child ? "child" : "root"} Utility approval`, async () => {
				const h = fixture(child)
				const executionAbort = new AbortController()
				Object.assign(h.config, {
					execution: {
						identity: {
							executionId: "execution",
							owner: { rootTaskId: "root", taskId: "task", runId: "run" },
							requestId: "request", nativeToolCallId: "call", toolName: "execute_command",
							toolSnapshot: { requestId: "request", inventoryVersion: 1 },
						},
						signal: executionAbort.signal,
						appendOutput: async () => { },
						beginWait: async () => ({ release: async () => {} }),
					}
				})
				if (phase === "evaluation") {
					h.decide.callsFake(async (_request, signal: AbortSignal) => {
						executionAbort.abort()
						assert.equal(signal.aborted, true)
						return { decision: "approve", reason: "Allowed" }
					})
				}
				const pending = createCardFromMessenger(h.config, h.params, [])
				if (phase === "publication") {
					await h.publicationStarted
					executionAbort.abort()
					h.finishPublication()
				}
				await assert.rejects(pending, /abort/i)
				assert.equal(h.cancellation.signal.aborted, false)
				sinon.assert.notCalled(h.waitForInteraction)
				if (phase === "evaluation") sinon.assert.notCalled(h.createCard)
				else assert.equal(h.createCard.firstCall.args[0].executionId, "execution")
			})
		}
	}
})
