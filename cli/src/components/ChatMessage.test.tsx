import { DiracMessage, DiracMessageType } from "@shared/ExtensionMessage"
import { render } from "ink-testing-library"
import React from "react"
import { describe, expect, it, vi } from "vitest"
import { ChatMessage } from "./ChatMessage"

vi.mock("../hooks/useTerminalSize", () => ({
	useTerminalSize: () => ({
		columns: 120,
		rows: 40,
		resizeKey: 0,
	}),
}))

describe("ChatMessage subagent rendering", () => {
	it("renders subagent approval prompts as a tree", () => {
		const message: DiracMessage = {
			id: "1",
			ts: Date.now(),
			content: {
				type: DiracMessageType.CARD,
				card: {
					id: "card-1",
					header: "Dirac wants to run subagents",
					status: "building" as any,
					renderType: "markdown",
					body: "### Dirac wants to run subagents:\n\n- Find codebase stats and size\n- Find funny comments and easter eggs\n- Find unusual patterns and history",
					requireApproval: true,
				},
			},
		}

		const { lastFrame } = render(React.createElement(ChatMessage, { message, mode: "act" }))
		const frame = lastFrame() || ""

		expect(frame).toContain("Dirac wants to run subagents")
		expect(frame).toContain("Find codebase stats and size")
		expect(frame).toContain("Find funny comments and easter eggs")
		expect(frame).toContain("Find unusual patterns and history")
	})

	it("renders subagent progress rows with compact token stats and completion checks", () => {
		const message: DiracMessage = {
			id: "2",
			ts: Date.now(),
			content: {
				type: DiracMessageType.CARD,
				card: {
					id: "card-2",
					header: "Dirac is running subagents",
					status: "running" as any,
					renderType: "markdown",
					body: "### Subagent Status (1/3)\n\n| # | Status | Prompt | Tokens (In/Out) | Cost |\n|---|--------|--------|-----------------|------|\n| 1 | ✅ completed | Find codebase stats and size | 24,400 / 0 | $0.0340 |\n| 2 | ⏳ running | Find funny comments and easter eggs | 31,600 / 0 | $0.0560 |\n| 3 | ⏳ pending | Find unusual patterns and history | 28,900 / 0 | $0.0000 |",
				},
			},
		}

		const { lastFrame } = render(React.createElement(ChatMessage, { isStreaming: true, message, mode: "act" }))
		const frame = lastFrame() || ""

		expect(frame).toContain("Dirac is running subagents")
		expect(frame).toContain("Find codebase stats and size")
		expect(frame).toContain("Find funny comments and easter eggs")
		expect(frame).toContain("Find unusual patterns and history")
	})
})
