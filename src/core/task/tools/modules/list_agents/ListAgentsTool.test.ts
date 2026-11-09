import { strict as assert } from "node:assert"
import { CardStatus } from "@shared/ExtensionMessage"
import { describe, it } from "mocha"
import sinon from "sinon"
import { isDiscoveredToolAvailableToTaskProfile } from "../../../TaskExecutionProfile"
import { buildOrchestrationTrait } from "../../adapters/traits/OrchestrationTraitBuilder"
import type { DiscoveredTool } from "../../discovery/DiscoveredTool"
import type { IToolEnvironment } from "../../interfaces/IToolEnvironment"
import type { TaskConfig } from "../../types/TaskConfig"
import { ListAgentsTool, list_agents_spec } from "./ListAgentsTool"
import { exposure } from "./tool"

function fixture(identity = { id: "root-task-id", parent: null as string | null }) {
	const page = { agents: [{ id: "Dirac", title_preview: "Root task", status: "running", accepts_messages: true }, { id: "Feynman", title_preview: "Inspect", status: "completed", accepts_messages: false }], next_cursor: "next" }
	const list = sinon.stub().returns(page)
	const card = { update: sinon.stub().resolves(), finalize: sinon.stub().resolves() }
	const createCard = sinon.stub().resolves(card)
	const env = { orchestration: { agentIdentity: identity, agentCommunication: { list } }, ui: { createCard } } as unknown as IToolEnvironment
	return { env, list, page, card, createCard }
}

describe("ListAgentsTool", () => {
	it("renders a readable roster while returning the runtime page unchanged", async () => {
		const { env, list, page, card, createCard } = fixture()
		assert.deepEqual(JSON.parse(await new ListAgentsTool().processCall({}, env)), page)
		sinon.assert.calledOnceWithExactly(list, {})
		sinon.assert.calledOnce(createCard)
		const params = createCard.firstCall.args[0]
		assert.equal(params.header, "Dirac is listing agents")
		assert.deepEqual(params.communication, { actor: "Dirac" })
		assert.equal(params.status, CardStatus.RUNNING)
		assert.equal(params.collapsed, false)
		assert.equal(params.do_not_auto_collapse, true)
		sinon.assert.calledOnceWithExactly(card.update, {
			header: "Dirac listed agents",
			body: "Dirac — Root task\nStatus: running; messages: available\n\nFeynman — Inspect\nStatus: completed; messages: unavailable",
			communication: { actor: "Dirac", detail: "Availability is a snapshot, not a reservation. More agents available; next cursor: next" },
		})
		sinon.assert.calledOnceWithExactly(card.finalize, CardStatus.SUCCESS, true)
	})

	it("uses the stable child ID and explains an empty page without inventing pagination", async () => {
		const { env, list, card, createCard } = fixture({ id: "Curie", parent: "Dirac" })
		list.returns({ agents: [] })
		assert.deepEqual(JSON.parse(await new ListAgentsTool().processCall({}, env)), { agents: [] })
		assert.equal(createCard.firstCall.args[0].communication.actor, "Curie")
		assert.equal(card.update.firstCall.args[0].header, "Curie listed agents")
		assert.equal(card.update.firstCall.args[0].body, "No agents on this page.")
		assert.equal(card.update.firstCall.args[0].communication.detail, "Availability is a snapshot, not a reservation.")
	})

	it("forwards opaque cursors and maximum limit without consuming or filtering the roster", async () => {
		const { env, list } = fixture()
		await new ListAgentsTool().processCall({ cursor: "exact cursor", limit: 50 }, env)
		sinon.assert.calledOnceWithExactly(list, { cursor: "exact cursor", limit: 50 })
	})

	it("rejects malformed queries and unsupported peer inspection/control fields", async () => {
		const { env, list, createCard } = fixture()
		const invalid = [null, [], "query", { cursor: " " }, { cursor: 1 }, ...[0, -1, 51, 1.5, "10", null, NaN].map((limit) => ({ limit })),
			...["root", "from", "operation", "view", "tasklet_id", "offset"].map((key) => ({ [key]: "unexpected" }))]
		for (const query of invalid) await assert.rejects(new ListAgentsTool().processCall(query, env))
		sinon.assert.notCalled(list)
		sinon.assert.notCalled(createCard)
	})

	it("surfaces runtime cursor failures and finalizes its error card", async () => {
		const { env, list, card } = fixture()
		const error = new Error("Cursor belongs to another root")
		list.throws(error)
		await assert.rejects(new ListAgentsTool().processCall({ cursor: "wrong" }, env), (caught) => caught === error)
		sinon.assert.calledOnceWithExactly(card.update, {
			header: "Dirac failed to list agents",
			communication: { actor: "Dirac", detail: error.message },
		})
		sinon.assert.calledOnceWithExactly(card.finalize, CardStatus.ERROR, true)
	})

	it("rejects discovery without a runtime capability", async () => {
		const { env, createCard } = fixture()
		delete (env.orchestration as { agentCommunication?: unknown }).agentCommunication
		await assert.rejects(new ListAgentsTool().processCall({}, env), /unavailable/)
		sinon.assert.notCalled(createCard)
	})

	it("exposes communication for every profile without exposing child supervision", () => {
		const agentCommunication = { send: sinon.stub(), list: sinon.stub() }
		const tasklets = {}
		for (const executionProfile of ["standalone", "goal_coordinator", "goal_followup", "tasklet"] as const) {
			const trait = buildOrchestrationTrait({ executionProfile, callbacks: { agentCommunication, tasklets } } as unknown as TaskConfig)
			assert.equal(trait.agentCommunication, agentCommunication)
			assert.equal(trait.tasklets, executionProfile === "tasklet" ? undefined : tasklets)
			assert.equal(isDiscoveredToolAvailableToTaskProfile(executionProfile, { exposure, spec: list_agents_spec } as DiscoveredTool), true)
		}
		assert.deepEqual(exposure, { kind: "context_only" })
		assert.match(list_agents_spec.description, /Default 10, maximum 50 agents and 16 KiB/)
		assert.deepEqual(list_agents_spec.parameters?.map((parameter) => parameter.name), ["cursor", "limit"])
	})
})
