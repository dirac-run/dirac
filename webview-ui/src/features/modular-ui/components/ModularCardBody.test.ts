import { CardStatus, SubagentExecutionStatus, type Card } from "@shared/ExtensionMessage"
import {
	createSubagentCardInput,
	createSubagentCardOutput,
	SubagentTrajectoryEventType,
} from "@shared/subagents"
import { describe, expect, it } from "vitest"
import { resolveCardBodyPresentation, SUBAGENT_CARD_MAX_HEIGHT_PX } from "./ModularCardBody"

describe("resolveCardBodyPresentation", () => {
	it("shows subagent tool calls without tool outputs and applies a fixed scroll height", () => {
		const identity = { id: 2, name: "Pauli" }
		const card: Card = {
			id: "subagent",
			header: identity.name,
			status: CardStatus.RUNNING,
			renderType: "markdown",
			body: "backend-formatted body",
			rawInput: createSubagentCardInput(identity, "Inspect the implementation", "Inspecting implementation"),
			rawOutput: createSubagentCardOutput(SubagentExecutionStatus.RUNNING, [
				{ type: SubagentTrajectoryEventType.TOOL, text: "read_file(paths=[\"src/file.ts\"])" },
				{ type: SubagentTrajectoryEventType.TOOL_RESULT, text: "secret tool output" },
			]),
		}

		const presentation = resolveCardBodyPresentation(card)

		expect(presentation.body).toContain("read_file")
		expect(presentation.body).not.toContain("secret tool output")
		expect(presentation.body).not.toContain("Agent 2")
		expect(presentation.maxHeight).toBe(SUBAGENT_CARD_MAX_HEIGHT_PX)
	})

	it.each([
		SubagentExecutionStatus.COMPLETED,
		SubagentExecutionStatus.FAILED,
		SubagentExecutionStatus.CANCELLED,
	])("ends a %s subagent body with one usage row", (status) => {
		const usage = {
			inputTokens: 105062, outputTokens: 1995, cacheReadTokens: 80000, cacheWriteTokens: 0, totalCost: 0.0123,
		}
		const card: Card = {
			id: "subagent", header: "Pauli", status: CardStatus.RUNNING, renderType: "markdown",
			rawInput: createSubagentCardInput({ id: 2, name: "Pauli" }, "Inspect"),
			rawOutput: createSubagentCardOutput(status, [], usage),
		}
		const body = resolveCardBodyPresentation(card).body!
		expect(body.split("\n").at(-1)).toBe(
			"Input: 105,062 · Output: 1,995 · Cache read: 80,000 · Cache write: 0 · Cost: $0.0123",
		)
		expect(body.match(/Cost:/g)).toHaveLength(1)
		card.rawOutput = createSubagentCardOutput(SubagentExecutionStatus.RUNNING, [], usage)
		expect(resolveCardBodyPresentation(card).body).not.toContain("Cost:")
		card.rawOutput = createSubagentCardOutput(status, [])
		expect(resolveCardBodyPresentation(card).body).not.toContain("Cost:")
	})

	it("preserves ordinary card bodies and height limits", () => {
		const card: Card = {
			id: "ordinary",
			header: "Ordinary",
			status: CardStatus.RUNNING,
			renderType: "text",
			body: "full output",
			maxHeight: 640,
		}

		expect(resolveCardBodyPresentation(card)).toEqual({ body: "full output", maxHeight: 640 })
	})
})
