import { strict as assert } from "node:assert"
import { CardStatus } from "@shared/ExtensionMessage"
import { afterEach, describe, it } from "mocha"
import sinon from "sinon"
import { ulid } from "ulid"
import { isDiscoveredToolAvailableToTaskProfile } from "../../../TaskExecutionProfile"
import type { DiscoveredTool } from "../../discovery/DiscoveredTool"
import type { IToolEnvironment } from "../../interfaces/IToolEnvironment"
import { PRESENTATION_OPERATION_TIMEOUT_MS } from "../../subagent/PresentationDeadline"
import { SharedJournalTool, shared_journal_spec } from "./SharedJournalTool"
import { exposure } from "./tool"

function fixture(identity: IToolEnvironment["orchestration"]["agentIdentity"] = { id: "Curie", parent: "Dirac" }) {
	const id = ulid()
	const receipt = { published: true, message_id: id, notifications: { enqueued: 1, skipped_inactive: 1, rejected_capacity: 2 } }
	const record = {
		version: 1,
		id,
		author: "Feynman",
		created_at: 1,
		headline: "Finding",
		content: "Complete body\nwith all details",
	}
	const publish = sinon.stub().resolves(receipt)
	const read = sinon.stub().resolves(record)
	const card = { update: sinon.stub().resolves(), finalize: sinon.stub().resolves() }
	const createCard = sinon.stub().resolves(card)
	const warn = sinon.stub()
	const env = {
		orchestration: { agentIdentity: identity, sharedJournal: { publish, read } },
		ui: { createCard },
		logging: { warn },
	} as unknown as IToolEnvironment
	return { env, publish, read, receipt, record, card, createCard, warn }
}

describe("SharedJournalTool", () => {
	afterEach(() => sinon.restore())

	for (const role of ["Scout", "Custom role", "default", undefined]) {
		it(`shows only a non-default saved role (${role}) in journal headers`, async () => {
			const { env, record, card, createCard } = fixture({ id: "Curie", parent: "Dirac", role })
			const label = role && role !== "default" ? `Curie [${role}]` : "Curie"
			await new SharedJournalTool().processCall({ operation: "publish", headline: "Finding", content: "Body" }, env)
			assert.equal(createCard.firstCall.args[0].header, `${label} · Journal publication`)
			assert.equal(card.update.firstCall.args[0].header, `${label} · Journal publication`)
			assert.deepEqual(card.update.firstCall.args[0].communication, { actor: "Curie" })
			await new SharedJournalTool().processCall({ operation: "read", message_id: record.id }, env)
			assert.equal(card.update.lastCall.args[0].header, `${label} · Journal read`)
		})
	}

	it("shows the verbatim finding with only a capacity warning beyond publication status", async () => {
		const { env, publish, receipt, card, createCard } = fixture()
		const input = { headline: " Finding ", content: " Complete body\n " }
		assert.deepEqual(JSON.parse(await new SharedJournalTool().processCall({ operation: "publish", ...input }, env)), receipt)
		sinon.assert.calledOnceWithExactly(publish, input)
		const params = createCard.firstCall.args[0]
		assert.equal(params.header, "Curie · Journal publication")
		assert.equal(params.body, `${input.headline}\n\n${input.content}\n\nPublishing...`)
		assert.deepEqual(params.communication, { actor: "Curie" })
		assert.equal(params.status, CardStatus.RUNNING)
		assert.equal(params.collapsed, true)
		assert.equal(params.do_not_auto_collapse, undefined)
		const update = card.update.firstCall.args[0]
		assert.equal(update.header, "Curie · Journal publication")
		assert.equal(update.body, `${input.headline}\n\n${input.content}\n\nPublished.\n\nWarning: 2 notifications rejected for capacity.`)
		assert.doesNotMatch(update.body, new RegExp(receipt.message_id))
		assert.deepEqual(update.communication, { actor: "Curie" })
		sinon.assert.calledOnceWithExactly(card.finalize, CardStatus.SUCCESS)
	})
	it("omits routine notification counts and warnings when none are rejected", async () => {
		const { env, receipt, card } = fixture()
		receipt.notifications.rejected_capacity = 0
		const input = { operation: "publish", headline: " Finding ", content: " Complete body\n " }
		assert.deepEqual(JSON.parse(await new SharedJournalTool().processCall(input, env)), receipt)
		assert.equal(card.update.firstCall.args[0].body, `${input.headline}\n\n${input.content}\n\nPublished.`)
	})
	it("reads the verbatim finding with author while preserving its machine return", async () => {
		const { env, read, record, card, createCard } = fixture()
		record.headline = " Finding \n "
		record.content = " Complete body\nwith all details\n "
		assert.deepEqual(JSON.parse(await new SharedJournalTool().processCall({ operation: "read", message_id: record.id }, env)), record)
		sinon.assert.calledOnceWithExactly(read, { message_id: record.id })
		assert.equal(createCard.firstCall.args[0].header, "Curie · Journal read")
		assert.equal(createCard.firstCall.args[0].communication.detail, undefined)
		assert.doesNotMatch(createCard.firstCall.args[0].body, new RegExp(record.id))
		sinon.assert.calledOnceWithExactly(card.update, {
			header: "Curie · Journal read",
			body: `${record.headline}\n\n${record.content}\n\nAuthor: ${record.author}`,
			communication: { actor: "Curie" },
		})
		sinon.assert.calledOnceWithExactly(card.finalize, CardStatus.SUCCESS)
	})
	it("names the root Dirac for both publication and reading", async () => {
		const { env, record, card, createCard } = fixture({ id: "root-task-id", parent: null, role: "Scout" })
		await new SharedJournalTool().processCall({ operation: "publish", headline: "Finding", content: "Body" }, env)
		assert.equal(createCard.firstCall.args[0].communication.actor, "Dirac")
		assert.equal(card.update.firstCall.args[0].header, "Dirac · Journal publication")
		await new SharedJournalTool().processCall({ operation: "read", message_id: record.id }, env)
		assert.equal(card.update.lastCall.args[0].header, "Dirac · Journal read")
	})
	it("shows read failures truthfully without claiming the finding was read", async () => {
		const { env, read, record, card } = fixture()
		const error = new Error("Publication not found")
		read.rejects(error)
		await assert.rejects(new SharedJournalTool().processCall({ operation: "read", message_id: record.id }, env), (caught) => caught === error)
		sinon.assert.calledOnceWithExactly(card.update, {
			header: "Curie · Journal read",
			body: "Read failed.",
			communication: { actor: "Curie" },
		})
		sinon.assert.calledOnceWithExactly(card.finalize, CardStatus.ERROR)
	})
	it("rejects unsupported operations, cross-operation fields, spoofing, paths and oversized UTF-8 fields", async () => {
		const { env, read, publish, createCard, record } = fixture()
		const valid = { operation: "publish", headline: "x", content: "x" }
		const invalid = [null, [], {}, { operation: "list" }, { operation: "read", message_id: "../path" },
			{ operation: "read", message_id: record.id, content: "x" }, { ...valid, message_id: record.id },
			{ ...valid, headline: " " }, { ...valid, content: "\n" }, { ...valid, headline: "é".repeat(129) }, { ...valid, content: "é".repeat(8193) },
			...["from", "author", "root", "path", "reply_to"].map((key) => ({ ...valid, [key]: "spoof" }))]
		for (const input of invalid) await assert.rejects(new SharedJournalTool().processCall(input, env))
		sinon.assert.notCalled(read)
		sinon.assert.notCalled(publish)
		sinon.assert.notCalled(createCard)
	})
	it("accepts UTF-8 field boundaries and propagates record/storage validation failures", async () => {
		const { env, publish, card } = fixture()
		await new SharedJournalTool().processCall({ operation: "publish", headline: "é".repeat(128), content: "é".repeat(8192) }, env)
		publish.rejects(new Error("Serialized journal record exceeds 32 KiB"))
		await assert.rejects(new SharedJournalTool().processCall({ operation: "publish", headline: "x", content: "x" }, env), /32 KiB/)
		assert.equal(card.update.lastCall.args[0].header, "Curie · Journal publication")
		assert.equal(card.update.lastCall.args[0].body, "x\n\nx\n\nPublication failed.")
		assert.equal(card.update.lastCall.args[0].communication.detail, undefined)
		assert.equal(card.finalize.lastCall.args[0], CardStatus.ERROR)
	})
	for (const operation of ["publish", "read"] as const) {
		for (const phase of ["create", "update", "finalize"] as const) {
			it(`preserves the ${operation} result when card ${phase} fails`, async () => {
				const { env, publish, read, card, createCard, receipt, record, warn } = fixture()
				const error = new Error("Display failed for opaque-publication-id")
				const presentation = phase === "create" ? createCard : card[phase]
				presentation.rejects(error)
				const input =
					operation === "publish"
						? { operation, headline: "Finding", content: "Authored source hash abc123" }
						: { operation, message_id: record.id }
				assert.deepEqual(
					JSON.parse(await new SharedJournalTool().processCall(input, env)),
					operation === "publish" ? receipt : record,
				)
				sinon.assert.calledOnce(operation === "publish" ? publish : read)
				sinon.assert.calledOnce(warn)
				assert.equal(warn.firstCall.args[1], error)
				if (phase !== "create") {
					sinon.assert.calledOnce(card.update)
					sinon.assert.calledOnceWithExactly(card.finalize, CardStatus.SUCCESS)
					assert.match(
						card.update.firstCall.args[0].body,
						operation === "publish" ? /Published\./ : /Author: Feynman/,
					)
				}
			})

			for (const lateOutcome of ["resolve", "reject"] as const) {
				it(`bounds stalled card ${phase} with late ${lateOutcome} without losing the ${operation} result`, async () => {
					const clock = sinon.useFakeTimers()
					const { env, publish, read, card, createCard, receipt, record, warn } = fixture()
					let settle!: (value: any) => void
					let reject!: (reason: Error) => void
					const stalled = new Promise<any>((resolve, fail) => {
						settle = resolve
						reject = fail
					})
					const presentation = phase === "create" ? createCard : card[phase]
					presentation.returns(stalled)
					const input = operation === "publish"
						? { operation, headline: "Finding", content: "Complete body" }
						: { operation, message_id: record.id }
					const pending = new SharedJournalTool().processCall(input, env)
					await clock.tickAsync(PRESENTATION_OPERATION_TIMEOUT_MS + 1)
					assert.deepEqual(JSON.parse(await pending), operation === "publish" ? receipt : record)
					sinon.assert.calledOnce(operation === "publish" ? publish : read)
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

			it(`preserves the original ${operation} error even if card ${phase} fails`, async () => {
				const { env, publish, read, card, createCard, record, warn } = fixture()
				const error = new Error("Storage unavailable")
				const action = operation === "publish" ? publish : read
				action.rejects(error)
				const presentation = phase === "create" ? createCard : card[phase]
				presentation.rejects(new Error("Display failed"))
				const input =
					operation === "publish"
						? { operation, headline: "Finding", content: "Complete body" }
						: { operation, message_id: record.id }
				await assert.rejects(new SharedJournalTool().processCall(input, env), (caught) => caught === error)
				sinon.assert.calledOnce(action)
				sinon.assert.calledOnce(warn)
			})
		}
	}
	it("requires a bound capability and is available on all root and child profiles", async () => {
		const { env, createCard } = fixture()
		delete (env.orchestration as { sharedJournal?: unknown }).sharedJournal
		await assert.rejects(new SharedJournalTool().processCall({ operation: "publish", headline: "x", content: "x" }, env), /unavailable/)
		sinon.assert.notCalled(createCard)
		const tool = { spec: shared_journal_spec, exposure } as DiscoveredTool
		for (const profile of ["standalone", "goal_coordinator", "goal_followup", "tasklet"] as const) assert.equal(isDiscoveredToolAvailableToTaskProfile(profile, tool), true)
		assert.match(shared_journal_spec.description, /never block completion/)
	})
})
