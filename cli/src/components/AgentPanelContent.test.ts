import { CardStatus, DiracMessage, DiracMessageType, SubagentExecutionStatus, TaskStatus } from "@shared/ExtensionMessage"
import { createSubagentCardInput, createSubagentCardOutput } from "@shared/subagents"
import { describe, expect, it } from "vitest"
import { buildAgentList, formatAgentLabel, getAgentListRowLimit } from "./AgentPanelContent"

describe("buildAgentList", () => {
	it("restores a persisted legacy subagent preview without requiring a tasklet record", () => {
		const messages: DiracMessage[] = JSON.parse(
			JSON.stringify([
				{
					id: "legacy-subagent",
					ts: 1000,
					content: {
						type: "card",
						card: {
							id: "legacy-subagent",
							header: "Curie: Review legacy artifacts",
							status: "success",
							renderType: "markdown",
							rawInput: {
								isSubagent: true,
								agentId: 7,
								agentName: "Curie",
								taskTitle: "Review legacy artifacts",
								prompt: "Inspect retained audit artifacts",
							},
							rawOutput: {
								status: "running",
								trajectory: [
									{ type: "tool", text: "read_file(legacy.md)" },
									{ type: "tool_result", text: "Retained audit contents" },
									{ type: "result", text: "Legacy review complete" },
								],
							},
						},
					},
				},
			]),
		)

		const agents = buildAgentList(messages, TaskStatus.COMPLETED)

		expect(agents).toHaveLength(2)
		expect(agents[1]).toMatchObject({
			id: 7,
			name: "Curie",
			taskTitle: "Review legacy artifacts",
			prompt: "Inspect retained audit artifacts",
			status: SubagentExecutionStatus.COMPLETED,
		})
		expect(formatAgentLabel(agents[1])).toBe("Curie: Review legacy artifacts")
		expect(agents[1].transcript).toContain("read_file(legacy.md)")
		expect(agents[1].transcript).toContain("Retained audit contents")
		expect(agents[1].transcript).toContain("Legacy review complete")
		expect(agents[1].transcript).not.toContain("running")
		expect(agents[0].transcript).not.toContain("Legacy review complete")
	})

	it("keeps Dirac first and exposes named subagent status, prompt, and trajectory", () => {
		const messages: DiracMessage[] = [
			{
				id: "task",
				ts: 1,
				content: { type: DiracMessageType.MARKDOWN, content: "Investigate agents", role: "user" as const },
			},
			{
				id: "agent-message",
				ts: 2,
				content: {
					type: DiracMessageType.MARKDOWN,
					content: "**Shannon:** Working on it.",
					role: "assistant",
					agentId: 2,
					agentName: "Shannon",
				},
			},
			{
				id: "agent",
				ts: 3,
				content: {
					type: DiracMessageType.CARD,
					card: {
						id: "agent",
						header: "Shannon",
						status: CardStatus.RUNNING,
						renderType: "markdown" as const,
						rawInput: createSubagentCardInput({ id: 2, name: "Shannon" }, "Trace the event flow", "Tracing event flow"),
						rawOutput: createSubagentCardOutput(SubagentExecutionStatus.RUNNING, []),
					},
				},
			},
		]

		const agents = buildAgentList(messages, TaskStatus.THINKING)

		expect(agents.map((agent) => agent.name)).toEqual(["Dirac", "Shannon"])
		expect(agents[0].id).toBe(1)
		expect(agents[0].status).toBe(SubagentExecutionStatus.RUNNING)
		expect(agents[0].transcript).not.toContain("Shannon")
		expect(agents[1]).toMatchObject({
			id: 2,
			status: SubagentExecutionStatus.RUNNING,
			taskTitle: "Tracing event flow",
			prompt: "Trace the event flow",
		})
		expect(agents[1].transcript).toContain("Trajectory")
		expect(formatAgentLabel(agents[1])).toBe("Shannon: Tracing event flow")
		expect(formatAgentLabel(agents[1], 12)).toBe("Shannon: Tr…")
	})
})

describe("formatAgentLabel", () => {
	it("clips oversized task labels to one terminal row", () => {
		const label = formatAgentLabel({ name: "Pauli", taskTitle: "x".repeat(100) }, 20)

		expect(label).toHaveLength(20)
		expect(label.endsWith("…")).toBe(true)
	})
})


describe("getAgentListRowLimit", () => {
	it("reserves panel chrome and always leaves room for one agent", () => {
		expect(getAgentListRowLimit(6)).toBe(1)
		expect(getAgentListRowLimit(24)).toBe(8)
	})
})
