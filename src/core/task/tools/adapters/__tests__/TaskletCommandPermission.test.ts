import assert from "node:assert/strict"
import { describe, it } from "mocha"
import sinon from "sinon"
import { CardStatus } from "@shared/ExtensionMessage"
import { DiracAskResponse } from "@shared/WebviewMessage"
import { UtilityPermissionDecisionService } from "@core/permissions/UtilityPermissionDecisionService"
import type { TaskConfig } from "../../types/TaskConfig"
import type { CardParams } from "../../interfaces/ICardHandle"
import { createCardFromMessenger, createManualInteractionCardFromMessenger } from "../traits/UiTraitBuilder"

function fixture() {
	const cancellation = new AbortController()
	const decide = sinon.stub().resolves({ decision: "approve", reason: "Allowed by policy" })
	const createCard = sinon.stub().callsFake(async (params) => ({
		id: "card",
		getCard: () => ({ ...params, id: "card", status: params.status ?? CardStatus.WAITING_FOR_INPUT }),
		waitForInteraction: sinon.stub().resolves({ action: DiracAskResponse.REJECT, response: DiracAskResponse.REJECT }),
	}))
	const config = {
		executionProfile: "tasklet",
		cwd: "/workspace",
		mode: "act",
		yoloModeToggled: true,
		toolUse: { name: "execute_command", params: { script: "python tool.py", language: "bash" } },
		taskId: "Feynman",
		taskState: { abortSignal: cancellation.signal },
		taskMessenger: { routesToOwner: true, createCard },
		autoApprover: { isUnrestrictedAutoApprove: sinon.stub().returns(true) },
		permissionDecisionBinding: { authorityMode: "act", configurationRevision: 1, commandPermissionRevision: 0, service: { decide } },
	} as unknown as TaskConfig
	const params: CardParams = {
		header: "Execute script",
		requireApproval: true,
		permissionRequestKind: "tool",
		permissionOperation: { kind: "commands", commands: ["@root:python tool.py"] },
	}
	return { config, params, decide, createCard, cancellation }
}

describe("Tasklet command Utility routing", () => {
	it("approves a command before owner interaction and supplies full arguments, resolved commands and child identity", async () => {
		const h = fixture()
		const card = await createCardFromMessenger(h.config, h.params, [])
		assert.equal((await card.waitForInteraction()).action, DiracAskResponse.APPROVE)
		sinon.assert.calledOnce(h.decide)
		assert.deepEqual(h.decide.firstCall.args[0], {
			toolCall: { name: "execute_command", arguments: { script: "python tool.py", language: "bash" } },
			permission: { header: "Execute script", operation: h.params.permissionOperation },
			runtime: { cwd: "/workspace", mode: "act", isSubagent: true },
		})
		sinon.assert.calledOnce(h.createCard)
		assert.equal(h.createCard.firstCall.args[0].status, CardStatus.SUCCESS)
		assert.equal(h.createCard.firstCall.args[0].requireApproval, undefined)
		assert.equal(h.createCard.firstCall.args[0].header, "Feynman · Auto-approved")
		assert.deepEqual(h.createCard.firstCall.args[0].communication, { actor: "Feynman" })
		assert.equal(h.createCard.firstCall.args[0].collapsed, true)
		assert.match(h.createCard.firstCall.args[0].body, /Source:\*\* Utility permission policy/)
	})

	it("uses the parent Plan authority mode while the child executes in Act", async () => {
		const h = fixture()
		h.config.permissionDecisionBinding!.authorityMode = "plan"
		await createCardFromMessenger(h.config, h.params, [])
		assert.equal(h.config.mode, "act")
		assert.deepEqual(h.decide.firstCall.args[0].runtime, { cwd: "/workspace", mode: "plan", isSubagent: true })
	})

	for (const name of ["write_to_file", "edit_file", "edit_ast"]) {
		it(`routes unresolved ${name} to the owner with exact paths and arguments`, async () => {
			const h = fixture()
			h.config.toolUse = { name, params: { paths: ["src/a.ts", "/outside/b.ts"] } }
			h.params.permissionOperation = { kind: "paths", paths: ["src/a.ts", "/outside/b.ts"] }
			const card = await createCardFromMessenger(h.config, h.params, [])
			assert.equal(card.requiresUserInteraction, false)
			assert.equal((await card.waitForInteraction()).action, DiracAskResponse.REJECT)
			sinon.assert.notCalled(h.decide)
			const forwarded = h.createCard.firstCall.args[0]
			assert.deepEqual(forwarded.permissionOperation, h.params.permissionOperation)
			assert.deepEqual(forwarded.toolCall, { name, arguments: h.config.toolUse.params })
			assert.equal(forwarded.requireApproval, true)
			assert.equal(forwarded.isAutoApproved, undefined)
		})
	}

	it("routes Utility escalation to the owner with its reason, without YOLO bypass", async () => {
		const h = fixture()
		h.decide.resolves({ decision: "escalate", reason: "Policy does not cover this command" })
		const card = await createCardFromMessenger(h.config, h.params, [])
		assert.equal((await card.waitForInteraction()).action, DiracAskResponse.REJECT)
		assert.equal(h.createCard.firstCall.args[0].utilityPermissionEscalation, "Policy does not cover this command")
		assert.deepEqual(h.createCard.firstCall.args[0].permissionOperation, h.params.permissionOperation)
		assert.equal(h.createCard.firstCall.args[0].requireApproval, true)
	})

	it("routes directly to the owner when Utility is not configured", async () => {
		const h = fixture()
		h.config.permissionDecisionBinding = undefined
		await createCardFromMessenger(h.config, h.params, [])
		sinon.assert.notCalled(h.decide)
		assert.equal(h.createCard.firstCall.args[0].requireApproval, true)
		assert.match(h.createCard.firstCall.args[0].utilityPermissionSkipped, /disabled or not fully configured/)
		assert.equal(h.createCard.firstCall.args[0].utilityPermissionEscalation, undefined)
	})

	it("routes evaluator failures to the owner through the service's escalation result", async () => {
		const h = fixture()
		h.config.permissionDecisionBinding!.service = new UtilityPermissionDecisionService({
			async *run() { throw new Error("Provider unavailable") },
		}, "Allow project commands")
		await createCardFromMessenger(h.config, h.params, [])
		assert.match(h.createCard.firstCall.args[0].utilityPermissionEscalation, /reliable permission decision/)
		assert.equal(h.createCard.firstCall.args[0].requireApproval, true)
	})

	for (const change of ["configuration", "rules", "disabled"] as const) {
		it(`escalates rather than using an approval after ${change} changes`, async () => {
			const h = fixture()
			h.decide.callsFake(async () => {
				const binding = h.config.permissionDecisionBinding!
				h.config.permissionDecisionBinding = change === "disabled" ? undefined : {
					...binding,
					configurationRevision: binding.configurationRevision + (change === "configuration" ? 1 : 0),
					commandPermissionRevision: (binding.commandPermissionRevision ?? 0) + (change === "rules" ? 1 : 0),
				}
				return { decision: "approve", reason: "Old policy allows this" }
			})
			await createCardFromMessenger(h.config, h.params, [])
			assert.match(h.createCard.firstCall.args[0].utilityPermissionEscalation, /settings changed/)
			assert.equal(h.createCard.firstCall.args[0].requireApproval, true)
		})
	}
	for (const change of ["configuration", "rules", "disabled", "cancellation"] as const) {
		it(`does not use an approval when ${change} changes during publication`, async () => {
			const h = fixture()
			h.createCard.callsFake(async (params) => {
				if (params.toolName === "permission_approval") {
					const binding = h.config.permissionDecisionBinding!
					if (change === "cancellation") h.cancellation.abort()
					else h.config.permissionDecisionBinding = change === "disabled" ? undefined : {
						...binding,
						configurationRevision: binding.configurationRevision + (change === "configuration" ? 1 : 0),
						commandPermissionRevision: (binding.commandPermissionRevision ?? 0) + (change === "rules" ? 1 : 0),
					}
				}
				return {
					id: "card",
					getCard: () => ({ ...params, id: "card", status: params.status ?? CardStatus.WAITING_FOR_INPUT }),
					waitForInteraction: sinon.stub().resolves({ action: DiracAskResponse.REJECT, response: DiracAskResponse.REJECT }),
				}
			})
			if (change === "cancellation") {
				await assert.rejects(createCardFromMessenger(h.config, h.params, []), /abort/i)
				assert.equal(h.createCard.callCount, 1)
				return
			}
			const card = await createCardFromMessenger(h.config, h.params, [])
			assert.equal((await card.waitForInteraction()).action, DiracAskResponse.REJECT)
			assert.equal(h.createCard.callCount, 2)
			assert.match(h.createCard.secondCall.args[0].utilityPermissionEscalation, /changed during approval publication/)
			assert.deepEqual(h.createCard.secondCall.args[0].permissionOperation, h.params.permissionOperation)
		})
	}


	for (const name of ["browser_action", "upsert_tool", "custom_tool"]) {
		it(`does not introduce child Utility approval for ${name}`, async () => {
			const h = fixture()
			h.config.toolUse!.name = name
			await createCardFromMessenger(h.config, h.params, [])
			sinon.assert.notCalled(h.decide)
			assert.equal(h.createCard.firstCall.args[0].requireApproval, true)
			assert.match(h.createCard.firstCall.args[0].utilityPermissionSkipped, /Dirac review/)
		})
	}

	for (const kind of ["manual_tool", undefined] as const) {
		it(`keeps ${kind ?? "unclassified"} requests owner-routed`, async () => {
			const h = fixture()
			h.params.permissionRequestKind = kind
			await createCardFromMessenger(h.config, h.params, [])
			sinon.assert.notCalled(h.decide)
			sinon.assert.calledOnce(h.createCard)
		})
	}

	it("keeps explicit manual interactions owner-routed", async () => {
		const h = fixture()
		await createManualInteractionCardFromMessenger(h.config, h.params, [])
		sinon.assert.notCalled(h.decide)
		sinon.assert.calledOnce(h.createCard)
	})

	it("cancellation does not create an owner request or execute an approved command", async () => {
		const h = fixture()
		h.decide.callsFake(async () => {
			h.cancellation.abort()
			return { decision: "approve", reason: "Allowed" }
		})
		await assert.rejects(createCardFromMessenger(h.config, h.params, []), /abort/i)
		sinon.assert.notCalled(h.createCard)
	})
})
