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

function fixture() {
	const id = ulid()
	const receipt = { published: true, message_id: id, notifications: { enqueued: 1, skipped_inactive: 1, rejected_capacity: 2 } }
	const record = { version: 1, id, author: "Feynman", created_at: 1, headline: "Finding", content: "Complete body" }
	const publish = sinon.stub().resolves(receipt)
	const read = sinon.stub().resolves(record)
	const card = { update: sinon.stub().resolves(), finalize: sinon.stub().resolves() }
	const createCard = sinon.stub().resolves(card)
	const env = { orchestration: { sharedJournal: { publish, read } }, ui: { createCard } } as unknown as IToolEnvironment
	return { env, publish, read, receipt, record, card, createCard }
}

describe("SharedJournalTool", () => {
	it("preserves publication fields and returns partial fanout as successful publication", async () => {
		const { env, publish, receipt, card } = fixture()
		const input = { headline: " Finding ", content: " Complete body\n " }
		assert.deepEqual(JSON.parse(await new SharedJournalTool().processCall({ operation: "publish", ...input }, env)), receipt)
		sinon.assert.calledOnceWithExactly(publish, input)
		sinon.assert.calledOnceWithExactly(card.finalize, CardStatus.SUCCESS)
	})
	it("reads the full envelope without injecting full content into its generic card", async () => {
		const { env, read, record, card } = fixture()
		assert.deepEqual(JSON.parse(await new SharedJournalTool().processCall({ operation: "read", message_id: record.id }, env)), record)
		sinon.assert.calledOnceWithExactly(read, { message_id: record.id })
		sinon.assert.calledOnceWithExactly(card.update, { body: record.headline })
		sinon.assert.calledOnceWithExactly(card.finalize, CardStatus.SUCCESS)
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
