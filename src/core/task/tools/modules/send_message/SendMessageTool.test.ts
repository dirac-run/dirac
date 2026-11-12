import { strict as assert } from "node:assert"
import { CardStatus } from "@shared/ExtensionMessage"
import { taskletReceiptNote } from "@shared/taskletReceipt"
import { afterEach, describe, it } from "mocha"
import sinon from "sinon"
import { isDiscoveredToolAvailableToTaskProfile } from "../../../TaskExecutionProfile"
import type { DiscoveredTool } from "../../discovery/DiscoveredTool"
import type { IToolEnvironment } from "../../interfaces/IToolEnvironment"
import { PRESENTATION_OPERATION_TIMEOUT_MS } from "../../subagent/PresentationDeadline"
import { SendMessageTool, send_message_spec } from "./SendMessageTool"
import { exposure } from "./tool"

function fixture(identity: IToolEnvironment["orchestration"]["agentIdentity"] = { id: "Feynman", parent: "Dirac" }) {
	const send = sinon.stub().resolves({ accepted: true, message_id: "message-1" })
	const card = { update: sinon.stub().resolves(), finalize: sinon.stub().resolves() }
	const createCard = sinon.stub().resolves(card)
	const warn = sinon.stub()
	const env = {
		orchestration: { agentIdentity: identity, agentCommunication: { send } },
		ui: { createCard },
		logging: { warn },
	} as unknown as IToolEnvironment
	return { env, send, card, createCard, warn }
}

describe("SendMessageTool", () => {
	afterEach(() => sinon.restore())

	it("renders the existing parent sleep mail-wake receipt without implying completion", () => {
		assert.equal(taskletReceiptNote({ operation: "sleep", outcome: "woke", rows: [], wakeReason: "mail" }),
			"Agent message received.")
	})

	it("shows the actor, recipient and verbatim text without replacing it with a receipt", async () => {
		const { env, send, card, createCard } = fixture()
		const input = { to: " Schrödinger 2 ", text: "  A finding\n " }
		const output = await new SendMessageTool().processCall(input, env)
		sinon.assert.calledOnceWithExactly(send, input)
		assert.deepEqual(JSON.parse(output), { accepted: true, message_id: "message-1" })
		sinon.assert.calledOnce(createCard)
		const params = createCard.firstCall.args[0]
		assert.equal(params.header, "Feynman →  Schrödinger 2  · Message")
		assert.equal(params.body, `${input.text}\n\nSending...`)
		assert.deepEqual(params.communication, { actor: "Feynman" })
		assert.equal(params.status, CardStatus.RUNNING)
		assert.equal(params.collapsed, true)
		assert.equal(params.do_not_auto_collapse, undefined)
		assert.equal(params.taskletReceipt, undefined)
		const update = card.update.firstCall.args[0]
		assert.equal(update.header, "Feynman →  Schrödinger 2  · Message")
		assert.equal(update.body, `${input.text}\n\nMessage accepted.`)
		assert.deepEqual(update.communication, { actor: "Feynman" })
		assert.doesNotMatch(update.body, /message-1/)
		sinon.assert.calledOnceWithExactly(card.finalize, CardStatus.SUCCESS)
	})

	for (const [role, label] of [["Reviewer", "Feynman [Reviewer]"], ["default", "Feynman"], [undefined, "Feynman"]] as const) {
		it(`formats saved actor role ${role ?? "missing"} without changing recipient routing or actor metadata`, async () => {
			const { env, send, card, createCard } = fixture({ id: "Feynman", parent: "Dirac", role })
			const request = { to: "Planck", text: "Exact message" }
			await new SendMessageTool().processCall(request, env)
			for (const value of [createCard.firstCall.args[0], card.update.firstCall.args[0]]) {
				assert.equal(value.header, `${label} → Planck · Message`)
				assert.deepEqual(value.communication, { actor: "Feynman" })
			}
			sinon.assert.calledOnceWithExactly(send, request)
		})
	}

	it("always names the root Dirac rather than its task ID", async () => {
		const { env, card, createCard } = fixture({ id: "root-task-id", parent: null, role: "Reviewer" })
		await new SendMessageTool().processCall({ to: "Feynman", text: "hello" }, env)
		assert.equal(createCard.firstCall.args[0].communication.actor, "Dirac")
		assert.equal(card.update.firstCall.args[0].header, "Dirac → Feynman · Message")
	})

	it("rejects invalid shapes, missing fields, blank content, and caller authority/correlation fields", async () => {
		const { env, send, createCard } = fixture()
		const invalid = [null, [], "message", {}, { to: "Dirac" }, { text: "hello" }, { to: " ", text: "hello" }, { to: "Dirac", text: "\n " }, { to: 1, text: "hello" }, { to: "Dirac", text: 1 },
			...["operation", "from", "root", "reply_to", "unknown"].map((key) => ({ to: "Dirac", text: "hello", [key]: "spoof" }))]
		for (const input of invalid) await assert.rejects(new SendMessageTool().processCall(input, env))
		sinon.assert.notCalled(send)
		sinon.assert.notCalled(createCard)
	})

	it("enforces the 8 KiB UTF-8 boundary rather than character count", async () => {
		const { env, send } = fixture()
		await new SendMessageTool().processCall({ to: "Dirac", text: "é".repeat(4096) }, env)
		await assert.rejects(new SendMessageTool().processCall({ to: "Dirac", text: "é".repeat(4096) + "a" }, env), /8 KiB UTF-8/)
		sinon.assert.calledOnce(send)
	})

	it("surfaces runtime admission, backpressure, and envelope failures and finalizes the card", async () => {
		for (const message of ["Recipient settled", "Mailbox full", "Serialized envelope exceeds 16 KiB"]) {
			const { env, send, card } = fixture()
			const error = new Error(message)
			send.rejects(error)
			await assert.rejects(new SendMessageTool().processCall({ to: "Dirac", text: "hello" }, env), (caught) => caught === error)
			sinon.assert.calledOnceWithExactly(card.update, {
				header: "Feynman → Dirac · Message",
				body: "hello\n\nMessage not accepted.",
				communication: { actor: "Feynman" },
			})
			sinon.assert.calledOnceWithExactly(card.finalize, CardStatus.ERROR)
		}
	})

	for (const phase of ["create", "update", "finalize"] as const) {
		it(`preserves the accepted receipt when card ${phase} fails`, async () => {
			const { env, send, card, createCard, warn } = fixture()
			const error = new Error("Display failed for opaque-message-id")
			const operation = phase === "create" ? createCard : card[phase]
			operation.rejects(error)
			const output = await new SendMessageTool().processCall({ to: "Planck", text: "Authored source hash abc123" }, env)
			assert.deepEqual(JSON.parse(output), { accepted: true, message_id: "message-1" })
			sinon.assert.calledOnce(send)
			sinon.assert.calledOnce(warn)
			assert.equal(warn.firstCall.args[1], error)
			if (phase !== "create") {
				sinon.assert.calledOnce(card.update)
				sinon.assert.calledOnceWithExactly(card.finalize, CardStatus.SUCCESS)
				assert.equal(card.update.firstCall.args[0].body, "Authored source hash abc123\n\nMessage accepted.")
			}
		})

		for (const lateOutcome of ["resolve", "reject"] as const) {
			it(`bounds stalled card ${phase} with late ${lateOutcome} without losing accepted mail`, async () => {
				const clock = sinon.useFakeTimers()
				const { env, send, card, createCard, warn } = fixture()
				let settle!: (value: any) => void
				let reject!: (reason: Error) => void
				const stalled = new Promise<any>((resolve, fail) => {
					settle = resolve
					reject = fail
				})
				const operation = phase === "create" ? createCard : card[phase]
				operation.returns(stalled)
				const pending = new SendMessageTool().processCall({ to: "Planck", text: "Finding" }, env)
				await clock.tickAsync(PRESENTATION_OPERATION_TIMEOUT_MS + 1)
				assert.deepEqual(JSON.parse(await pending), { accepted: true, message_id: "message-1" })
				sinon.assert.calledOnce(send)
				sinon.assert.calledOnce(warn)
				const lateError = new Error("Late display failure")
				if (lateOutcome === "reject") reject(lateError)
				else settle(phase === "create" ? card : undefined)
				await clock.tickAsync(0)
				if (phase === "create" && lateOutcome === "resolve")
					sinon.assert.calledOnceWithExactly(card.finalize, CardStatus.ABANDONED)
				if (phase === "create" && lateOutcome === "reject")
					assert.equal(warn.lastCall.args[1], lateError)
			})
		}
	}

	for (const phase of ["create", "update", "finalize"] as const) {
		it(`preserves the original admission error even if card ${phase} fails`, async () => {
			const { env, send, card, createCard, warn } = fixture()
			const error = new Error("Mailbox full")
			send.rejects(error)
			const operation = phase === "create" ? createCard : card[phase]
			operation.rejects(new Error("Display failed"))
			await assert.rejects(
				new SendMessageTool().processCall({ to: "Planck", text: "Finding" }, env),
				(caught) => caught === error,
			)
			sinon.assert.calledOnce(send)
			sinon.assert.calledOnce(warn)
		})
	}

	it("requires runtime capability without exposing supervision", async () => {
		const { env, createCard } = fixture()
		delete (env.orchestration as { agentCommunication?: unknown }).agentCommunication
		await assert.rejects(new SendMessageTool().processCall({ to: "Dirac", text: "hello" }, env), /unavailable/)
		sinon.assert.notCalled(createCard)
	})

	it("is available on root and child profiles and documents persistence/authority limits", () => {
		const tool = { exposure, spec: send_message_spec } as DiscoveredTool
		for (const profile of ["standalone", "goal_coordinator", "goal_followup", "tasklet"] as const) assert.equal(isDiscoveredToolAvailableToTaskProfile(profile, tool), true)
		assert.deepEqual(exposure, { kind: "context_only" })
		assert.match(send_message_spec.description, /lost on crash, shutdown, or cancellation/)
		assert.match(send_message_spec.description, /never resolves structured questions/)
		assert.match(send_message_spec.description, /serialized message envelope to 16 KiB/)
		assert.deepEqual(send_message_spec.parameters?.map((parameter) => parameter.name), ["to", "text"])
	})
})
