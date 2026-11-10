import { strict as assert } from "node:assert"
import sinon from "sinon"
import { CardStatus, type Card } from "@shared/ExtensionMessage"
import { DiracAskResponse } from "@shared/WebviewMessage"
import type { ArchitectureDiagramEnvironment } from "../ArchitectureDiagramEnvironment"
import { ToolSkippedByUserMessage } from "../../../types/ToolSkippedByUserMessage"
import { create } from "../tool"

function fixture() {
	const data: Partial<Card> = { status: CardStatus.RUNNING }
	const wait = sinon.stub().resolves({ response: DiracAskResponse.APPROVE, text: "looks good" })
	const finalize = sinon.stub().callsFake(async (status) => {
		data.status = status
	})
	const card = {
		get status() {
			return data.status
		},
		update: async (patch: Partial<Card>) => {
			Object.assign(data, patch)
		},
		finalize,
		waitForInteraction: wait,
	}
	const prepare = sinon
		.stub()
		.callsFake(async (selection) => ({ available: true, selection: { ...selection, taskId: "owner" }, waitForInput: true }))
	const upsert = sinon.stub().resolves({ name: "tools", version: 3 })
	const env = {
		orchestration: { reportFailure: sinon.spy() },
		ui: { createCard: async () => card },
		architecture: { openDisplay: prepare, upsertDiagram: upsert },
	} as unknown as ArchitectureDiagramEnvironment
	return { data, wait, finalize, prepare, upsert, env }
}

describe("Architecture display handoff", () => {
	for (const input of [
		{ operation: "upsert_diagram", name: "tools", diagram: "{}" },
		{ operation: "display_diagram", name: "tools" },
		{ operation: "display_diagram", name: "tools", version: 1 },
		{ operation: "display_comparison", name: "tools", start_version: 2, end_version: 1 },
	])
		it(`persists navigation and waits via the existing interaction for ${JSON.stringify(input)}`, async () => {
			const f = fixture()
			const result = JSON.parse(await create().processCall(input, f.env))
			assert.equal(f.wait.callCount, 1)
			sinon.assert.callOrder(f.prepare, f.wait)
			if (input.operation === "upsert_diagram") {
				sinon.assert.callOrder(f.upsert, f.prepare, f.wait)
				assert.equal(result.saved, true)
				assert.equal(result.version, 3)
				assert.deepEqual(result.selection, { name: "tools", mode: "exact", version: 3 })
			}
			assert.equal(f.data.architectureReference?.taskId, "owner")
			assert.equal(f.data.requireApproval, undefined)
			assert.equal(f.data.actions, undefined)
			assert.equal(f.data.requireFeedback, false)
			assert.equal(f.data.status, CardStatus.SUCCESS)
			assert.equal(result.outcome, "answered")
			assert.equal(JSON.stringify(result).includes("owner"), false)
		})

	for (const input of [
		{ operation: "upsert_diagram", name: "tools", diagram: "{}" },
		{ operation: "display_diagram", name: "tools" },
		{ operation: "display_diagram", name: "tools", version: 1 },
		{ operation: "display_comparison", name: "tools", start_version: 2, end_version: 1 },
	])
		it(`offers persistent navigation without a wait or invented reply in autonomous mode: ${JSON.stringify(input)}`, async () => {
			const f = fixture()
			f.prepare.callsFake(async (selection) => ({
				available: true,
				selection: { ...selection, taskId: "owner" },
				waitForInput: false,
			}))
			f.wait.rejects(new Error("autonomous display must not wait"))
			const result = JSON.parse(await create().processCall(input, f.env))
			assert.equal(result.outcome, "displayed")
			assert.equal(result.response, undefined)
			assert.equal(JSON.stringify(result).includes("owner"), false)
			assert.deepEqual(f.data.architectureReference, { taskId: "owner", ...result.selection })
			assert.equal(f.data.status, CardStatus.SUCCESS)
			assert.equal(f.data.requireFeedback, false)
			assert.equal(f.data.requireApproval, undefined)
			assert.equal(f.data.feedbackPlaceholder, undefined)
			assert.equal(f.data.actions, undefined)
			assert.match(f.data.body!, /continues without waiting/)
			assert.match(result.message, /board was opened/)
			sinon.assert.notCalled(f.wait)
			sinon.assert.calledOnceWithExactly(f.finalize, CardStatus.SUCCESS)
		})

	it("does not wait or advertise navigation when unavailable or preparation fails", async () => {
		for (const failure of [false, true]) {
			const f = fixture()
			if (failure) f.prepare.rejects(new Error("missing assets"))
			else f.prepare.resolves({ available: false, reason: "host has no viewer" })
			const result = JSON.parse(await create().processCall({ operation: "display_diagram", name: "tools" }, f.env))
			assert.equal(result.outcome, failure ? "error" : "unavailable")
			assert.equal(f.wait.callCount, 0)
			assert.equal(f.data.architectureReference, undefined)
			assert.equal(f.data.status, CardStatus.ERROR)
		}
	})

	it("does not open or wait until publication succeeds", async () => {
		const f = fixture()
		let commit!: (identity: { name: string; version: number }) => void
		f.upsert.returns(
			new Promise((resolve) => {
				commit = resolve
			}),
		)
		const pending = create().processCall({ operation: "upsert_diagram", name: "tools", diagram: "{}" }, f.env)
		// Wait for the lazy tool implementation and the publication call, without resolving publication.
		await new Promise<void>((resolve) => setImmediate(resolve))
		sinon.assert.calledOnce(f.upsert)
		sinon.assert.notCalled(f.prepare)
		sinon.assert.notCalled(f.wait)
		commit({ name: "tools", version: 7 })
		const result = JSON.parse(await pending)
		sinon.assert.calledOnceWithExactly(f.prepare, { name: "tools", mode: "exact", version: 7 })
		assert.equal(result.version, 7)
		assert.equal(result.outcome, "answered")
	})

	it("returns save failures without opening or waiting", async () => {
		const f = fixture()
		f.upsert.rejects(new Error("nodes[0].id invalid"))
		const result = JSON.parse(
			await create().processCall({ operation: "upsert_diagram", name: "tools", diagram: "{}" }, f.env),
		)
		assert.equal(result.outcome, "error")
		assert.equal(result.saved, undefined)
		assert.match(result.error, /nodes\[0\].id/)
		sinon.assert.notCalled(f.prepare)
		sinon.assert.notCalled(f.wait)
		assert.equal(f.data.architectureReference, undefined)
	})

	for (const unavailable of [false, true]) {
		it(`preserves the committed identity after display ${unavailable ? "unavailability" : "failure"}`, async () => {
			const f = fixture()
			if (unavailable) f.prepare.resolves({ available: false, reason: "viewer unavailable" })
			else f.prepare.rejects(new Error("missing assets"))
			const result = JSON.parse(
				await create().processCall({ operation: "upsert_diagram", name: "tools", diagram: "{}" }, f.env),
			)
			assert.equal(result.operation, "upsert_diagram")
			assert.equal(result.saved, true)
			assert.equal(result.name, "tools")
			assert.equal(result.version, 3)
			assert.equal(result.outcome, unavailable ? "unavailable" : "error")
			assert.match(result.error, /Retry display_diagram/)
			assert.match(result.error, /not upsert_diagram/)
			sinon.assert.calledOnce(f.upsert)
			sinon.assert.notCalled(f.wait)
			assert.equal(f.data.architectureReference, undefined)
			assert.equal(f.data.status, CardStatus.ERROR)
		})
	}

	it("finalizes cancellation and preserves the shared user-message path", async () => {
		for (const error of [new Error("Task aborted while waiting"), new ToolSkippedByUserMessage("ordinary reply")]) {
			const f = fixture()
			f.wait.rejects(error)
			await assert.rejects(
				create().processCall({ operation: "display_diagram", name: "tools" }, f.env),
				(actual) => actual === error,
			)
			assert.equal(f.data.status, error instanceof ToolSkippedByUserMessage ? CardStatus.SKIPPED : CardStatus.CANCELLED)
			assert.ok(f.data.architectureReference)
			assert.equal(f.finalize.callCount, 1)
		}
	})

	it("does not apply a board I/O deadline to the user wait", async () => {
		const clock = sinon.useFakeTimers()
		try {
			const f = fixture()
			let answer!: (value: unknown) => void
			f.wait.callsFake(
				() =>
					new Promise((resolve) => {
						answer = resolve
					}),
			)
			const promise = create().processCall({ operation: "display_diagram", name: "tools" }, f.env)
			await clock.tickAsync(60_000)
			assert.equal(f.finalize.callCount, 0)
			answer({ response: DiracAskResponse.REJECT })
			await promise
			assert.equal(f.data.status, CardStatus.SKIPPED)
		} finally {
			clock.restore()
		}
	})
})
