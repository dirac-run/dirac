import { strict as assert } from "node:assert"
import { describe, it } from "mocha"
import { CardStatus, SubagentExecutionStatus } from "../ExtensionMessage"
import {
	appendSubagentTrajectoryEvent,
	createSubagentCardInput,
	createSubagentCardOutput,
	formatSubagentTrajectory,
	readSubagentCardData,
	recordSubagentProgress,
	SUBAGENT_TRAJECTORY_EVENT_MAX_CHARS,
	SUBAGENT_TRAJECTORY_MAX_EVENTS,
	SubagentTrajectoryEventType,
	type SubagentTrajectoryEvent,
} from "../subagents"

describe("subagent observability", () => {


	it("round-trips structured card metadata and bounds every trajectory line", () => {
		const identity = { id: 2, name: "Feynman" }
		const trajectory = [
			{ type: SubagentTrajectoryEventType.TOOL, text: `read_file(${"x".repeat(100)})` },
			{ type: SubagentTrajectoryEventType.TOOL_RESULT, text: "file contents" },
			{ type: SubagentTrajectoryEventType.RESULT, text: "Finished" },
		]
		const card = {
			id: "agent-card",
			header: "Feynman",
			status: CardStatus.SUCCESS,
			renderType: "markdown" as const,
			rawInput: createSubagentCardInput(identity, "Inspect the implementation", "Inspecting implementation"),
			rawOutput: createSubagentCardOutput(SubagentExecutionStatus.COMPLETED, trajectory),
		}

		const data = readSubagentCardData(card)
		assert.ok(data)
		assert.equal(data.taskTitle, "Inspecting implementation")
		assert.equal(data.status, SubagentExecutionStatus.COMPLETED)
		assert.deepEqual(data.trajectory, trajectory)
		const formatted = formatSubagentTrajectory(data, 40)
		assert.ok(formatted.split("\n").every((line) => line.length <= 40))
		assert.doesNotMatch(formatted, /Agent 2/)
		assert.match(formatted, /file contents/)
		const webviewFormatted = formatSubagentTrajectory(data, { includeToolResults: false })
		assert.match(webviewFormatted, /read_file/)
		assert.doesNotMatch(webviewFormatted, /file contents/)
	})
	it("reads legacy subagent cards without a task title", () => {
		const data = readSubagentCardData({
			id: "legacy-agent",
			header: "Curie",
			status: CardStatus.RUNNING,
			renderType: "markdown",
			rawInput: { isSubagent: true, agentId: 2, agentName: "Curie", prompt: "Research" },
			rawOutput: createSubagentCardOutput(SubagentExecutionStatus.RUNNING, []),
		})

		assert.ok(data)
		assert.equal(data.taskTitle, undefined)
	})

	it("uses terminal card status when raw subagent status is stale", () => {
		const data = readSubagentCardData({
			id: "stale-status-agent",
			header: "Gauss",
			status: CardStatus.SUCCESS,
			renderType: "markdown",
			rawInput: createSubagentCardInput({ id: 2, name: "Gauss" }, "Research", "Researching status"),
			rawOutput: createSubagentCardOutput(SubagentExecutionStatus.RUNNING, []),
		})

		assert.ok(data)
		assert.equal(data.status, SubagentExecutionStatus.COMPLETED)
		assert.match(formatSubagentTrajectory(data), /No trajectory events were recorded/)
		assert.doesNotMatch(formatSubagentTrajectory(data), /Waiting to start/)
	})

	it("caps stored trajectory events and truncates oversized event text", () => {
		const trajectory: SubagentTrajectoryEvent[] = []
		for (let index = 0; index < SUBAGENT_TRAJECTORY_MAX_EVENTS + 5; index++) {
			appendSubagentTrajectoryEvent(trajectory, {
				type: SubagentTrajectoryEventType.TOOL_RESULT,
				text: `${index}:${"x".repeat(SUBAGENT_TRAJECTORY_EVENT_MAX_CHARS + 100)}`,
			})
		}

		assert.equal(trajectory.length, SUBAGENT_TRAJECTORY_MAX_EVENTS)
		assert.match(trajectory[0].text, /^5:/)
		assert.ok(trajectory.every((event) => event.text.length <= SUBAGENT_TRAJECTORY_EVENT_MAX_CHARS))
		const output = createSubagentCardOutput(SubagentExecutionStatus.RUNNING, trajectory)
		assert.equal((output.trajectory as unknown[]).length, SUBAGENT_TRAJECTORY_MAX_EVENTS)
	})

	it("de-duplicates an identical terminal result during authoritative reconciliation", () => {
		const trajectory: SubagentTrajectoryEvent[] = []
		const result = {
			status: SubagentExecutionStatus.COMPLETED,
			result: "Finished",
			durationMs: 10,
		}

		recordSubagentProgress(trajectory, result)
		recordSubagentProgress(trajectory, result)

		assert.deepEqual(trajectory, [{ type: SubagentTrajectoryEventType.RESULT, text: "Finished" }])
	})

})
