import { strict as assert } from "node:assert"
import { CardStatus } from "@shared/ExtensionMessage"
import { describe, it } from "mocha"
import sinon from "sinon"
import { ulid } from "ulid"
import { isDiscoveredToolAvailableToTaskProfile } from "../../../TaskExecutionProfile"
import type { DiscoveredTool } from "../../discovery/DiscoveredTool"
import type { IToolEnvironment } from "../../interfaces/IToolEnvironment"
import { SharedJournalTool, shared_journal_spec } from "./SharedJournalTool"
import { exposure } from "./tool"

function fixture(identity = { id: "Curie", parent: "Dirac" as string | null }) {
	const id = ulid()
	const receipt = { published: true, message_id: id, notifications: { enqueued: 1, skipped_inactive: 1, rejected_capacity: 2 } }
	const record = { version: 1, id, author: "Feynman", created_at: 1, headline: "Finding", content: "Complete body\nwith all details" }
	const publish = sinon.stub().resolves(receipt)
	const read = sinon.stub().resolves(record)
	const card = { update: sinon.stub().resolves(), finalize: sinon.stub().resolves() }
	const createCard = sinon.stub().resolves(card)
	const env = { orchestration: { agentIdentity: identity, sharedJournal: { publish, read } }, ui: { createCard } } as unknown as IToolEnvironment
	return { env, publish, read, receipt, record, card, createCard }
}

describe("SharedJournalTool", () => {
	it("shows the full finding and secondary notification counts without receipt JSON", async () => {
		const { env, publish, receipt, card, createCard } = fixture()
		const input = { headline: " Finding ", content: " Complete body\n " }
		assert.deepEqual(JSON.parse(await new SharedJournalTool().processCall({ operation: "publish", ...input }, env)), receipt)
		sinon.assert.calledOnceWithExactly(publish, input)
		const params = createCard.firstCall.args[0]
		assert.equal(params.header, "Curie is publishing a finding")
		assert.equal(params.body, `${input.headline}\n\n${input.content}`)
		assert.deepEqual(params.communication, { actor: "Curie" })
		assert.equal(params.status, CardStatus.RUNNING)
		assert.equal(params.collapsed, false)
		assert.equal(params.do_not_auto_collapse, true)
		const update = card.update.firstCall.args[0]
		assert.equal(update.header, "Curie published a finding")
		assert.equal(update.body, undefined)
		assert.match(update.communication.detail, new RegExp(receipt.message_id))
		assert.match(update.communication.detail, /1 accepted, 1 skipped inactive, 2 rejected for capacity/)
		assert.match(update.communication.detail, /delivery and action are not confirmed/)
		sinon.assert.calledOnceWithExactly(card.finalize, CardStatus.SUCCESS, true)
	})
	it("reads the full finding with author and publication ID while preserving its machine return", async () => {
		const { env, read, record, card, createCard } = fixture()
		assert.deepEqual(JSON.parse(await new SharedJournalTool().processCall({ operation: "read", message_id: record.id }, env)), record)
		sinon.assert.calledOnceWithExactly(read, { message_id: record.id })
		assert.equal(createCard.firstCall.args[0].header, "Curie is reading a finding")
		assert.equal(createCard.firstCall.args[0].communication.detail, `Publication ${record.id}`)
		sinon.assert.calledOnceWithExactly(card.update, {
			header: "Curie read Feynman's finding",
			body: `${record.headline}\n\n${record.content}`,
			communication: { actor: "Curie", detail: `Publication ${record.id}` },
		})
		sinon.assert.calledOnceWithExactly(card.finalize, CardStatus.SUCCESS, true)
	})
	it("names the root Dirac for both publication and reading", async () => {
		const { env, record, card, createCard } = fixture({ id: "root-task-id", parent: null })
		await new SharedJournalTool().processCall({ operation: "publish", headline: "Finding", content: "Body" }, env)
		assert.equal(createCard.firstCall.args[0].communication.actor, "Dirac")
		assert.equal(card.update.firstCall.args[0].header, "Dirac published a finding")
		await new SharedJournalTool().processCall({ operation: "read", message_id: record.id }, env)
		assert.equal(card.update.lastCall.args[0].header, "Dirac read Feynman's finding")
	})
	it("shows read failures truthfully without claiming the finding was read", async () => {
		const { env, read, record, card } = fixture()
		const error = new Error("Publication not found")
		read.rejects(error)
		await assert.rejects(new SharedJournalTool().processCall({ operation: "read", message_id: record.id }, env), (caught) => caught === error)
		sinon.assert.calledOnceWithExactly(card.update, {
			header: "Curie failed to read a finding",
			communication: { actor: "Curie", detail: error.message },
		})
		sinon.assert.calledOnceWithExactly(card.finalize, CardStatus.ERROR, true)
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
		assert.equal(card.update.lastCall.args[0].header, "Curie failed to publish a finding")
		assert.equal(card.update.lastCall.args[0].body, undefined)
		assert.match(card.update.lastCall.args[0].communication.detail, /32 KiB/)
		assert.equal(card.finalize.lastCall.args[0], CardStatus.ERROR)
	})
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
