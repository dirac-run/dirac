import { strict as assert } from "node:assert"
import { CardStatus } from "@shared/ExtensionMessage"
import { taskletReceiptNote } from "@shared/taskletReceipt"
import { describe, it } from "mocha"
import sinon from "sinon"
import { isDiscoveredToolAvailableToTaskProfile } from "../../../TaskExecutionProfile"
import type { DiscoveredTool } from "../../discovery/DiscoveredTool"
import type { IToolEnvironment } from "../../interfaces/IToolEnvironment"
import { SendMessageTool, send_message_spec } from "./SendMessageTool"
import { exposure } from "./tool"

function fixture() {
	const send = sinon.stub().resolves({ accepted: true, message_id: "message-1" })
	const card = { update: sinon.stub().resolves(), finalize: sinon.stub().resolves() }
	const createCard = sinon.stub().resolves(card)
	const env = { orchestration: { agentCommunication: { send } }, ui: { createCard } } as unknown as IToolEnvironment
	return { env, send, card, createCard }
}

describe("SendMessageTool", () => {
	it("renders the existing parent sleep mail-wake receipt without implying completion", () => {
		assert.equal(taskletReceiptNote({ operation: "sleep", outcome: "woke", rows: [], wakeReason: "mail" }),
			"Ordinary agent message. A wake is not assignment completion.")
	})

	it("preserves exact recipient/text and returns volatile acceptance through its own generic card", async () => {
		const { env, send, card, createCard } = fixture()
		const input = { to: " Schrödinger 2 ", text: "  A finding\n " }
		const output = await new SendMessageTool().processCall(input, env)
		sinon.assert.calledOnceWithExactly(send, input)
		assert.deepEqual(JSON.parse(output), { accepted: true, message_id: "message-1" })
		sinon.assert.calledOnce(createCard)
		sinon.assert.calledOnceWithExactly(card.finalize, CardStatus.SUCCESS)
		assert.match(card.update.firstCall.args[0].body, /volatile.*not confirmed/)
		assert.equal(createCard.firstCall.args[0].taskletReceipt, undefined)
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
			sinon.assert.calledOnceWithExactly(card.update, { body: message })
			sinon.assert.calledOnceWithExactly(card.finalize, CardStatus.ERROR)
		}
	})

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
