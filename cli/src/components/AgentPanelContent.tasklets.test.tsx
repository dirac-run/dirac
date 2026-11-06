import { CardStatus, type DiracMessage, DiracMessageType, TaskStatus } from "@shared/ExtensionMessage"
import { createTaskletPresentationCard, type TaskletPresentationData } from "@shared/taskletPresentation"
import { render } from "ink-testing-library"
// biome-ignore lint/correctness/noUnusedImports: Classic JSX runtime requires React in scope.
import React from "react"
import { describe, expect, it, vi } from "vitest"
import { AgentPanelContent, buildAgentList } from "./AgentPanelContent"

const input = vi.hoisted(() => ({ handler: undefined as ((input: string, key: import("ink").Key) => void) | undefined }))
vi.mock("ink", async (original) => ({
	...(await original<typeof import("ink")>()),
	useInput: (handler: typeof input.handler) => {
		input.handler = handler
	},
}))
vi.mock("../hooks/useTerminalSize", () => ({ useTerminalSize: () => ({ columns: 120, rows: 50 }) }))

const delay = () => new Promise((resolve) => setTimeout(resolve, 60))
const data: TaskletPresentationData = {
	taskletId: "tl-stable",
	title: "Trace events",
	createdAt: 2,
	prompt: "Trace event delivery",
	status: "running",
	communications: ["Parent: a decision is needed"],
	activity: ["Read diagnostic.ts"],
}
function messages(tasklet: TaskletPresentationData): DiracMessage[] {
	return [
		{
			id: "root-prompt",
			ts: 1,
			content: { type: DiracMessageType.MARKDOWN, role: "user", content: "Delegate and continue" },
		},
		{
			id: "spawn",
			ts: 2,
			content: {
				type: DiracMessageType.CARD,
				card: { id: "spawn", header: "Delegation accepted", renderType: "text", status: CardStatus.SUCCESS },
			},
		},
		{
			id: "tasklet:tl-stable",
			ts: 3,
			content: { type: DiracMessageType.CARD, card: createTaskletPresentationCard(tasklet) },
		},
		{
			id: "tasklet:tl-sibling",
			ts: 4,
			content: {
				type: DiracMessageType.CARD,
				card: createTaskletPresentationCard({ ...data, taskletId: "tl-sibling", title: "Sibling", createdAt: 3 }),
			},
		},
	]
}
function key(overrides: Partial<import("ink").Key>) {
	if (!input.handler) throw new Error("Agent panel input was not registered")
	input.handler("", { ...overrides } as import("ink").Key)
}

describe("CLI tasklet agent view", () => {
	it.each([
		"running",
		"waiting",
		"completed",
		"failed",
		"interrupted",
	] as const)("restores %s independently of spawn and root", (status) => {
		const restored = JSON.parse(JSON.stringify(messages({ ...data, status, result: "Retained result" })))
		const agents = buildAgentList(restored, TaskStatus.THINKING)
		expect(agents).toHaveLength(3)
		expect(agents[0].status).toBe("running")
		expect(agents[0].transcript).toContain("Delegation accepted")
		expect(agents[0].transcript).not.toContain("Tasklet tl-stable")
		expect(agents[1]).toMatchObject({ id: "tl-stable", status, prompt: data.prompt })
		expect(agents[1].transcript).toContain("Retained result")
		expect(agents[1].transcript).toContain("Parent-directed communication")
		expect(agents[1].transcript).toContain("Diagnostic activity (not parent requests)")
		expect(agents[2].status).toBe("running")
	})

	it("keeps the selected stable ID current through waiting, completion and reopening", async () => {
		const view = render(<AgentPanelContent messages={messages(data)} onClose={() => {}} taskStatus={TaskStatus.THINKING} />)
		await delay()
		expect(view.lastFrame()).toContain("Trace events · running")
		expect(view.lastFrame()).not.toContain("tl-stable")
		key({ downArrow: true })
		await delay()
		key({ return: true })
		await delay()
		expect(view.lastFrame()).toContain("Assignment")
		for (const status of ["waiting", "completed", "running", "interrupted"] as const) {
			view.rerender(
				<AgentPanelContent
					messages={messages({ ...data, status, result: `Result ${status}` })}
					onClose={() => {}}
					taskStatus={TaskStatus.THINKING}
				/>,
			)
			await delay()
			expect(view.lastFrame()).toContain(`Trace events · ${status}`)
			expect(view.lastFrame()).toContain(`Result ${status}`)
			expect(view.lastFrame()).toContain("Parent-directed communication")
			expect(view.lastFrame()).toContain("Diagnostic activity (not parent requests)")
			if (status === "waiting") expect(view.lastFrame()).toContain("no user approval is requested here")
		}
		view.unmount()
	})
})
