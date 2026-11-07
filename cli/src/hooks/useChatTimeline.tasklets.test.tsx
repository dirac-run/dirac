import { type DiracMessage, DiracMessageType, CardStatus } from "@shared/ExtensionMessage"
import {
	createTaskletPresentationCard,
	type TaskletPresentationStatus,
	type TaskletPresentationData,
} from "@shared/taskletPresentation"
import { getApiMetrics } from "@shared/getApiMetrics"
import { Box, Static, Text } from "ink"
import { render } from "ink-testing-library"
// biome-ignore lint/correctness/noUnusedImports: CLI tests use the classic JSX runtime.
import React from "react"
import { describe, expect, it, vi } from "vitest"
import { ChatMessage } from "../components/ChatMessage"
import { type ChatTimelineResult, useChatTimeline } from "./useChatTimeline"

vi.mock("./useTerminalSize", () => ({
	useTerminalSize: () => ({ columns: 120, rows: 40, resizeKey: 0 }),
}))

function tasklet(status: TaskletPresentationStatus, result?: string): DiracMessage {
	const card = createTaskletPresentationCard({
		taskletId: "tl_reopen",
		title: "Worker",
		prompt: "Inspect",
		createdAt: 2,
		status,
		result,
		communications: [],
		activity: [],
	})
	return { id: card.id, ts: 2, content: { type: DiracMessageType.CARD, card } }
}
function text(id: string, lines = 1): DiracMessage {
	return { id, ts: 1, content: { type: DiracMessageType.MARKDOWN, role: "assistant", content: `${id}\n`.repeat(lines) } }
}
const messageItems = (items: ChatTimelineResult["staticItems"] | ChatTimelineResult["dynamicItems"]) =>
	items.filter((item) => item.type === "message")
const statuses = (items: ReturnType<typeof messageItems>) =>
	items.flatMap(({ message }) => (message.content.type === DiracMessageType.CARD ? [message.content.card.status] : []))

describe("tasklet scrollback revisions", () => {
	it("reopens an already printed same-ID tasklet at the live tail and archives displaced revisions once", async () => {
		let timeline!: ChatTimelineResult
		function Transcript({ messages }: { messages: DiracMessage[] }) {
			timeline = useChatTimeline({
				messages,
				showHeader: false,
				terminalColumns: 120,
				layoutRows: { liveViewportRows: 6, activeContentRows: 4, compactHistoryRows: 2 },
				shouldSuppressCardBody: () => false,
			})
			return (
				<Box flexDirection="column">
					<Static items={timeline.staticItems}>
						{(item) =>
							item.type === "message" ? (
								<ChatMessage key={item.key} message={item.message} />
							) : (
								<Text key={item.key}>boundary</Text>
							)
						}
					</Static>
					{timeline.dynamicItems.map((item) =>
						item.type === "message" ? (
							<ChatMessage
								key={item.key}
								maxContentLines={item.maxContentLines}
								message={item.message}
								tailOnly={item.tailOnly}
							/>
						) : (
							<Text key={item.key}>boundary</Text>
						),
					)}
				</Box>
			)
		}
		const first = text("root")
		const latest = text("parent continues", 20)
		const completed = tasklet("completed", "old result")
		const view = render(<Transcript messages={[first, completed, latest]} />)
		expect(statuses(messageItems(timeline.staticItems))).toEqual(["success"])
		const originalSnapshots = timeline.staticItems
		const update = async (status: TaskletPresentationStatus, result?: string, extra: DiracMessage[] = []) => {
			view.rerender(<Transcript messages={[first, tasklet(status, result), latest, ...extra]} />)
			await new Promise((resolve) => setTimeout(resolve, 30))
		}

		await update("waiting")
		expect(timeline.staticItems.slice(0, originalSnapshots.length)).toEqual(originalSnapshots)
		expect(timeline.dynamicItems.at(-1)).toMatchObject({
			type: "message",
			message: { id: "tasklet:tl_reopen", content: { card: { status: "waiting_for_input" } } },
		})
		expect(view.lastFrame()).toContain("waiting")
		expect(view.lastFrame()?.split("Worker · waiting").at(-1)).not.toContain("old result")
		expect(view.lastFrame()).not.toContain("tl_reopen")

		await update("running")
		expect(view.lastFrame()).toContain("running")
		expect(statuses(messageItems(timeline.staticItems))).toEqual(["success"])
		await update("completed", "new result")
		expect(view.lastFrame()).toContain("completed")
		expect(timeline.dynamicItems.at(-1)).toMatchObject({
			message: { content: { card: { body: expect.stringContaining("new result") } } },
		})

		const next = text("next parent turn", 20)
		await update("completed", "new result", [next])
		expect(statuses(messageItems(timeline.staticItems))).toEqual(["success", "success"])
		const snapshots = timeline.staticItems
		expect(new Set(snapshots.map((item) => item.key)).size).toBe(snapshots.length)
		// Deserialized, otherwise identical root snapshots must not print revisions again.
		await update("completed", "new result", [JSON.parse(JSON.stringify(next))])
		expect(timeline.staticItems).toBe(snapshots)
		expect(messageItems(timeline.staticItems)[1].message).toBe(completed)
		view.unmount()
	})

	it.each(["stream", "interaction"] as const)("keeps active parent %s visible across child revisions", async (kind) => {
		let timeline!: ChatTimelineResult
		const parent: DiracMessage =
			kind === "stream"
				? text("parent stream", 20)
				: {
					id: "parent approval",
					ts: 3,
					content: {
						type: DiracMessageType.CARD,
						card: {
							id: "parent approval",
							header: "Approve the parent operation",
							body: "Approval details\n".repeat(20),
							renderType: "text",
							status: CardStatus.WAITING_FOR_INPUT,
						},
					},
				}
		function Probe({ messages, columns = 80 }: { messages: DiracMessage[]; columns?: number }) {
			timeline = useChatTimeline({
				messages,
				activeVoiceStreamId: kind === "stream" ? parent.id : undefined,
				showHeader: false,
				terminalColumns: columns,
				layoutRows: { liveViewportRows: 8, activeContentRows: 6, compactHistoryRows: 2 },
				shouldSuppressCardBody: () => false,
			})
			return <Text>probe</Text>
		}
		const first = text("root")
		const view = render(<Probe messages={[first, tasklet("running"), parent]} />)
		expect(statuses(messageItems(timeline.staticItems))).toEqual(["running"])
		for (const status of ["waiting", "completed"] as const) {
			view.rerender(<Probe messages={[first, tasklet(status, "Private result\n".repeat(20)), parent]} />)
			await new Promise((resolve) => setTimeout(resolve, 30))
			expect(messageItems(timeline.dynamicItems).map(({ message }) => message.id)).toEqual([parent.id])
			expect(messageItems(timeline.staticItems).map(({ message }) => message.id)).not.toContain(parent.id)
		}
		expect(statuses(messageItems(timeline.staticItems))).toEqual(["running", "waiting_for_input", "success"])
		const snapshots = timeline.staticItems
		const messages = [first, tasklet("completed", "Private result\n".repeat(20)), parent]
		view.rerender(<Probe columns={60} messages={JSON.parse(JSON.stringify(messages))} />)
		await new Promise((resolve) => setTimeout(resolve, 30))
		expect(messageItems(timeline.dynamicItems).map(({ message }) => message.id)).toEqual([parent.id])
		expect(timeline.staticItems).toBe(snapshots)
		view.unmount()
	})

	it("archives displaced waiting tasklet snapshots and later parent output instead of hiding them", () => {
		let timeline!: ChatTimelineResult
		function Probe() {
			timeline = useChatTimeline({
				messages: [text("root"), tasklet("waiting"), text("completed parent output"), text("sibling progress", 20)],
				showHeader: false,
				terminalColumns: 120,
				layoutRows: { liveViewportRows: 6, activeContentRows: 4, compactHistoryRows: 2 },
				shouldSuppressCardBody: () => false,
			})
			return <Text>probe</Text>
		}
		const view = render(<Probe />)
		expect(statuses(messageItems(timeline.staticItems))).toEqual(["waiting_for_input"])
		expect(messageItems(timeline.staticItems).map(({ message }) => message.id)).toContain("completed parent output")
		expect(timeline.displayMessages).toHaveLength(4)
		view.unmount()
	})

	it("does not archive activity-only updates as revisions, but does archive a new status once", async () => {
		let timeline!: ChatTimelineResult
		function Probe({ messages }: { messages: DiracMessage[] }) {
			timeline = useChatTimeline({
				messages,
				showHeader: false,
				terminalColumns: 120,
				layoutRows: { liveViewportRows: 6, activeContentRows: 4, compactHistoryRows: 2 },
				shouldSuppressCardBody: () => false,
			})
			return <Text>probe</Text>
		}
		const first = tasklet("running")
		const tail = text("parent tail", 20)
		const view = render(<Probe messages={[text("root"), first, tail]} />)
		const archived = timeline.staticItems
		const activity = JSON.parse(JSON.stringify(first)) as DiracMessage
		if (activity.content.type !== DiracMessageType.CARD) throw new Error("Expected tasklet card")
		const presentation = activity.content.card.rawOutput!.tasklet as TaskletPresentationData
		presentation.activity = ["New private tool activity"]
		presentation.communications = ["A progress preview"]
		view.rerender(<Probe messages={[text("root"), activity, tail]} />)
		await new Promise((resolve) => setTimeout(resolve, 30))
		expect(timeline.staticItems).toBe(archived)
		view.rerender(<Probe messages={[text("root"), tasklet("waiting"), tail, text("later", 20)]} />)
		await new Promise((resolve) => setTimeout(resolve, 30))
		expect(statuses(messageItems(timeline.staticItems))).toEqual(["running", "waiting_for_input"])
		const changed = timeline.staticItems
		view.rerender(
			<Probe messages={JSON.parse(JSON.stringify([text("root"), tasklet("waiting"), tail, text("later", 20)]))} />,
		)
		await new Promise((resolve) => setTimeout(resolve, 30))
		expect(timeline.staticItems).toBe(changed)
		view.unmount()
	})

	it("hides restored accounting-only cards without changing the original contribution or totals", () => {
		const original: DiracMessage[] = [
			text("root"),
			{
				id: "usage",
				ts: 3,
				content: {
					type: DiracMessageType.CARD,
					card: {
						id: "usage",
						header: "Tasklet usage",
						renderType: "text",
						status: CardStatus.SUCCESS,
						rawOutput: {
							source: "tasklet",
							taskletId: "accounting-child",
							tokensIn: 42,
							tokensOut: 7,
							cost: 0.25,
							reasoningTokens: 0,
						},
					},
				},
			},
			tasklet("completed", "Retained result"),
		]
		const restored = JSON.parse(JSON.stringify(original))
		const before = getApiMetrics(restored)
		let timeline!: ChatTimelineResult
		function Probe() {
			timeline = useChatTimeline({
				messages: restored,
				showHeader: false,
				terminalColumns: 80,
				layoutRows: { liveViewportRows: 6, activeContentRows: 4, compactHistoryRows: 2 },
				shouldSuppressCardBody: () => false,
			})
			return <Text>probe</Text>
		}
		const view = render(<Probe />)
		expect(timeline.displayMessages.map((message) => message.id)).toEqual(["root", "tasklet:tl_reopen"])
		expect(getApiMetrics(restored)).toEqual(before)
		expect(before.totalTokensIn).toBe(42)
		expect(before.totalCost).toBe(0.25)
		expect(restored).toEqual(original)
		view.unmount()
	})
})
