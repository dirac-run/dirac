import { CardStatus, type DiracMessage, DiracMessageType } from "@shared/ExtensionMessage"
import { createTaskletPresentationCard, type TaskletPresentationData } from "@shared/taskletPresentation"
import { Box } from "ink"
import { render } from "ink-testing-library"
import React from "react"
import stringWidth from "string-width"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { cardDisplayBody } from "../../utils/card-body"
import { estimateTimelineMessageBodyRows, estimateTimelineMessageRows } from "../../utils/timeline-rows"
import { ChatMessage } from "../ChatMessage"
import { CardInteractions } from "./CardInteractions"
import { ModularCard } from "./ModularCard"

const terminalSize = vi.hoisted(() => ({ columns: 120, rows: 40, resizeKey: 0 }))
vi.mock("../../hooks/useTerminalSize", () => ({
	useTerminalSize: () => terminalSize,
}))

vi.mock("./CardInteractions", () => ({ CardInteractions: vi.fn(() => null) }))

const data: TaskletPresentationData = {
	taskletId: "tl_stable-string",
	title: "Inspect source",
	prompt: "Find the source of the regression",
	createdAt: 1,
	status: "running",
	communications: ["Parent: should I continue?"],
	activity: ["Read source files"],
}
const plain = (frame: string | undefined) => (frame ?? "").replace(/\u001B\[[0-9;]*m/g, "")

function message(tasklet: TaskletPresentationData): DiracMessage {
	const card = createTaskletPresentationCard(tasklet)
	return { id: card.id, ts: tasklet.createdAt, content: { type: DiracMessageType.CARD, card } }
}

describe("CLI tasklet cards", () => {
	beforeEach(() => {
		terminalSize.columns = 120
	})

	it.each([
		"running",
		"waiting",
		"completed",
		"failed",
		"interrupted",
	] as const)("renders restored %s status and retained projection details", (status) => {
		const restored = JSON.parse(JSON.stringify(message({ ...data, status, result: "Retained result" })))
		const view = render(<ChatMessage message={restored} mode="act" />)
		const frame = plain(view.lastFrame())
		expect(frame).toContain(`Tasklet tl_stable-string · ${status}`)
		expect(frame).toContain(status)
		expect(frame).toContain("Prompt")
		expect(frame).toContain(data.prompt)
		expect(frame).toContain("Result")
		expect(frame).toContain("Retained result")
		expect(frame).toContain("Communications (parent-directed)")
		expect(frame).toContain(data.communications[0])
		expect(frame).toContain("Activity (diagnostic)")
		expect(frame).toContain(data.activity[0])
		if (status === "waiting") expect(frame).toContain("Waiting for the parent")
		view.unmount()
	})

	it("updates the same card independently of spawn completion and siblings", async () => {
		const spawn = { id: "spawn", header: "Started tasklets", status: CardStatus.SUCCESS, renderType: "text" as const }
		const tree = (status: TaskletPresentationData["status"]): React.ReactElement => (
			<Box flexDirection="column">
				<ModularCard card={spawn} />
				<ModularCard card={createTaskletPresentationCard({ ...data, status })} />
				<ModularCard
					card={createTaskletPresentationCard({
						...data,
						taskletId: "tl_sibling",
						title: "Sibling",
						status: "running",
					})}
				/>
			</Box>
		)
		const view = render(tree("running"))
		view.rerender(tree("waiting"))
		await new Promise((resolve) => setTimeout(resolve, 30))
		let frame = plain(view.lastFrame())
		expect(frame).toContain("Started tasklets")
		expect(frame).toMatch(/tl_stable-string.*waiting/)
		expect(frame).toMatch(/tl_sibling.*running/)
		expect(frame).not.toContain("Approve")
		view.rerender(tree("completed"))
		await new Promise((resolve) => setTimeout(resolve, 30))
		frame = plain(view.lastFrame())
		expect(frame).toMatch(/tl_stable-string.*completed/)
		expect(frame).toMatch(/tl_sibling.*running/)
		view.unmount()
	})

	it("keeps status and stable identity visible with quiet or partially visible bodies", () => {
		const tasklet = message({ ...data, status: "waiting" })
		for (const props of [{ suppressCardBody: true }, { tailOnly: true, maxContentLines: 1 }]) {
			const view = render(<ChatMessage message={tasklet} {...props} />)
			const frame = plain(view.lastFrame())
			expect(frame).toContain("Tasklet tl_stable-string")
			expect(frame).toContain("waiting")
			expect(frame).not.toContain(data.prompt)
			view.unmount()
		}
	})

	it.each([
		"running",
		"waiting",
		"completed",
		"failed",
		"interrupted",
	] as const)("keeps narrow %s headers within the one-row timeline budget", (status) => {
		terminalSize.columns = 20
		for (const taskletId of ["tl_shared-prefix-abc123", "tl_shared-prefix-xyz789"]) {
			const tasklet = message({ ...data, taskletId, title: "Inspect a very long source title\nwith another line", status })
			for (const props of [{ suppressCardBody: true }, { tailOnly: true, maxContentLines: 1 }]) {
				const view = render(
					<Box flexDirection="column" width={20}>
						<ChatMessage message={tasklet} {...props} />
					</Box>,
				)
				const frame = plain(view.lastFrame())
				expect(frame.split("\n")).toHaveLength(estimateTimelineMessageRows(tasklet, 20, true))
				expect(stringWidth(frame)).toBeLessThanOrEqual(20)
				expect(frame).toContain(status)
				expect(frame).toContain(taskletId.slice(-5))
				expect(frame).toContain("…")
				expect(frame).not.toContain(data.prompt)
				view.unmount()
			}
		}
	})

	it("never routes a waiting tasklet through card interactions or root approval flags", () => {
		vi.mocked(CardInteractions).mockClear()
		const card = createTaskletPresentationCard({ ...data, status: "waiting" })
		expect(card.requireApproval).toBeUndefined()
		expect(card.requireFeedback).toBeUndefined()
		expect(card.actions).toBeUndefined()
		const view = render(<ModularCard card={card} />)
		expect(CardInteractions).not.toHaveBeenCalled()
		expect(plain(view.lastFrame())).toContain("Waiting for the parent")
		view.unmount()
	})

	it("does not mistake an arbitrary tasklet title for root completion", () => {
		const view = render(<ChatMessage message={message({ ...data, title: "Task Completed", status: "completed" })} />)
		expect(plain(view.lastFrame())).toContain("Task Completed · Tasklet tl_stable-string")
		expect(plain(view.lastFrame())).toContain("completed")
		view.unmount()
	})

	it("measures the displayed structured body, not the legacy fallback", () => {
		const tasklet = message(data)
		if (tasklet.content.type !== DiracMessageType.CARD) throw new Error("Expected card")
		const body = cardDisplayBody(tasklet.content.card)
		expect(estimateTimelineMessageBodyRows(tasklet, 120)).toBe(body.split("\n").length)
		expect(estimateTimelineMessageBodyRows(tasklet, 120, true)).toBe(0)
	})

	it("strips source anchors once and preserves literal tasklet preview contents", () => {
		const source = render(
			<ModularCard
				card={{
					id: "source",
					header: "Read file",
					status: CardStatus.SUCCESS,
					renderType: "text",
					body: "Anchor§Literal§value",
				}}
			/>,
		)
		expect(plain(source.lastFrame())).toContain("Literal§value")
		expect(plain(source.lastFrame())).not.toContain("Anchor§")
		source.unmount()
		const preview = render(<ModularCard card={createTaskletPresentationCard({ ...data, result: "Literal§value" })} />)
		expect(plain(preview.lastFrame())).toContain("Literal§value")
		preview.unmount()
	})

	it("preserves legacy card rendering", () => {
		const view = render(
			<ModularCard
				card={{
					id: "legacy",
					header: "Legacy subagent",
					status: CardStatus.SUCCESS,
					renderType: "text",
					body: "Legacy retained result",
				}}
			/>,
		)
		expect(plain(view.lastFrame())).toContain("Legacy retained result")
		expect(plain(view.lastFrame())).not.toContain("Communications (parent-directed)")
		view.unmount()
	})
})
