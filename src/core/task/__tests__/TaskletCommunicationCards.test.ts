import { strict as assert } from "node:assert"
import { CardStatus } from "@shared/ExtensionMessage"
import { ResponseOperation } from "@shared/responseTool"
import { DiracAskResponse } from "@shared/WebviewMessage"
import { describe, it } from "mocha"
import { taskletCommunicationCard } from "../TaskletCommunicationCards"
import type { TaskletEvent, TaskletInteraction } from "../types/tasklet"

function interaction(patch: Partial<TaskletInteraction> = {}): TaskletInteraction {
	return {
		id: "opaque-request-id", status: "pending", createdAt: 1, kind: "question",
		card: {
			id: "opaque-card-id", header: "Question", status: CardStatus.WAITING_FOR_INPUT, renderType: "markdown",
			rawInput: { text: "  Which approach?\n", options: ["Small", "Complete"] },
			requireFeedback: true, actions: [{ label: "Small", value: "small" }],
		},
		...patch,
	}
}

function event(communication: TaskletEvent["communication"]): TaskletEvent {
	return { id: "opaque-event-id", taskletId: "Feynman", createdAt: 1, communication }
}

function card(request: TaskletInteraction) {
	return taskletCommunicationCard(event({ type: "interaction", request }))!
}

function assertObservation(value: ReturnType<typeof card>) {
	assert.equal(value.collapsed, true)
	assert.equal(value.do_not_auto_collapse, undefined)
	assert.equal(value.requireApproval, undefined)
	assert.equal(value.requireFeedback, undefined)
	assert.equal(value.actions, undefined)
	assert.equal(value.rawInput, undefined)
	assert.doesNotMatch([value.header, value.body, value.communication?.detail].join("\n"), /opaque-(?:request|card|event)-id/)
}

describe("Tasklet communication cards", () => {
	it("shows exact question text, choices and pending state without executable controls or IDs", () => {
		const value = card(interaction())
		assert.equal(value.header, "Feynman · Question for Dirac")
		assert.ok(value.body!.startsWith("  Which approach?\n"))
		assert.match(value.body!, /Choices:\n- Small\n- Complete/)
		assert.match(value.body!, /Status: Awaiting Dirac/)
		assert.equal(value.status, CardStatus.RUNNING)
		assertObservation(value)
	})

	it("attributes an answer and selected label while retaining authored source hashes", () => {
		const value = card(interaction({
			status: "resolved", resolvedAt: 2,
			resolution: { action: "small", response: DiracAskResponse.MESSAGE, text: "  See source hash deadbeef0123\n" },
		}))
		assert.match(value.body!, /Answer from Dirac:/)
		assert.ok(value.body!.includes("  See source hash deadbeef0123\n"))
		assert.match(value.body!, /Choice: Small/)
		assert.equal(value.endTime, 2)
		assertObservation(value)
	})

	for (const escalated of [false, true]) {
		it(`shows a declined question with ${escalated ? "user" : "parent"} attribution, not an answered choice`, () => {
			const value = card(interaction({
				status: "resolved", resolvedAt: 2,
				decision: escalated ? { operation: "escalate" } : undefined,
				resolution: { action: DiracAskResponse.REJECT, response: DiracAskResponse.REJECT },
			}))
			assert.match(value.body!, escalated ? /Status: User via Dirac declined/ : /Status: Dirac declined/)
			assert.doesNotMatch(value.body!, /Status: Answered|Choice: reject/)
			assertObservation(value)
		})
	}

	it("keeps retired questions distinct from resolved answers", () => {
		const value = card(interaction({ status: "retired", retiredAt: 3 }))
		assert.equal(value.status, CardStatus.CANCELLED)
		assert.match(value.body!, /Closed without an answer/)
		assert.doesNotMatch(value.body!, /Answer from/)
		assertObservation(value)
	})

	it("shows Utility escalation and a single original command block without implying user escalation", () => {
		const original = "```bash\ngit status\n```"
		const value = card(interaction({
			kind: "permission", permissionOperation: { kind: "commands", commands: ["git status"] },
			utilityPermissionEscalation: "Policy is silent",
			card: { id: "opaque-card-id", header: "Execute command", body: original, status: CardStatus.WAITING_FOR_INPUT, renderType: "markdown", requireApproval: true },
		}))
		assert.equal(value.header, "Feynman · Permission for Dirac")
		assert.ok(value.body!.startsWith(original))
		assert.equal(value.body!.split("git status").length - 1, 1)
		assert.match(value.body!, /Awaiting Dirac approval/)
		assert.doesNotMatch(value.body!, /Observation only|permission not granted/)
		assert.match(value.body!, /Source: Utility escalation to Dirac/)
		assert.match(value.body!, /Reason: Policy is silent/)
		assert.doesNotMatch(value.body!, /requested user approval/)
		assertObservation(value)
	})

	it("shows the structured reason Utility was not consulted", () => {
		const value = card(interaction({
			kind: "permission", permissionOperation: { kind: "commands", commands: ["pwd"] },
			utilityPermissionSkipped: "Utility permission handling is disabled or not fully configured.",
		}))
		assert.match(value.body!, /```bash\npwd\n```/)
		assert.match(value.body!, /Source: Dirac review \(Utility not consulted\)/)
		assert.match(value.body!, /Utility permission handling is disabled or not fully configured/)
		assertObservation(value)
	})

	it("uses the actual resolved user outcome rather than inferring approval from the requested decision", () => {
		const value = card(interaction({
			kind: "permission", status: "resolved", resolvedAt: 4,
			permissionOperation: { kind: "tool", manualOnly: true },
			toolCall: { name: "custom", arguments: { target: "project" } },
			decision: { operation: "escalate" },
			resolution: { action: DiracAskResponse.REJECT, response: DiracAskResponse.REJECT },
		}))
		assert.match(value.body!, /Status: Rejected/)
		assert.match(value.body!, /Source: User via Dirac/)
		assert.match(value.body!, /```json\n\{\n  "target": "project"\n\}\n```/)
		assertObservation(value)
	})

	it("keeps permission explanations intact and closed requests distinct from approval", () => {
		const text = "  Explanation\n```bash\necho details\n```\n"
		const value = card(interaction({
			kind: "permission", status: "resolved", resolvedAt: 4,
			resolution: { action: DiracAskResponse.APPROVE, response: DiracAskResponse.APPROVE, text },
		}))
		assert.ok(value.body!.endsWith(text))
		assert.match(value.body!, /Status: Approved/)
		assert.doesNotMatch(value.body!, /Observation only/)
		const closed = card(interaction({ kind: "permission", status: "retired", retiredAt: 5 }))
		assert.match(closed.body!, /Status: Closed without approval/)
		assertObservation(closed)
	})

	it("keeps progress and committed results concise and preserves exact authored content", () => {
		const text = `  Original content\nsource hash abcd012345\n${"Detailed finding\n".repeat(200)}Ending\n`
		const update = taskletCommunicationCard(event({ type: "response", response: { operation: ResponseOperation.PROGRESS, text } }))!
		assert.equal(update.header, "Feynman · Update")
		assert.equal(update.body, text)
		assertObservation(update)
		const result = taskletCommunicationCard(event({ type: "outcome", outcome: { kind: "completed", response: text, completedAt: 2 } }))!
		assert.equal(result.header, "Feynman · Result")
		assert.equal(result.body, text)
		assertObservation(result)
		assert.equal(taskletCommunicationCard(event({ type: "response", response: { operation: ResponseOperation.COMPLETE, text } })), undefined)
	})

	it("does not decorate failed results with runtime error IDs", () => {
		const value = taskletCommunicationCard(event({ type: "outcome", outcome: { kind: "failed", failedAt: 2, error: { name: "Error", message: "Request opaque-request-id failed" } } }))!
		assert.equal(value.status, CardStatus.ERROR)
		assert.match(value.body!, /Assignment failed/)
		assertObservation(value)
	})
})
