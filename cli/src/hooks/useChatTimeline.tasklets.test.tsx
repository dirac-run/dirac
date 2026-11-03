import { type DiracMessage, DiracMessageType } from "@shared/ExtensionMessage"
import { createTaskletPresentationCard, type TaskletPresentationStatus } from "@shared/taskletPresentation"
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
const messageItems = (items: ChatTimelineResult["staticItems"]) => items.filter((item) => item.type === "message")
const statuses = (items: ReturnType<typeof messageItems>) =>
	items.flatMap(({ message }) => (message.content.type === DiracMessageType.CARD ? [message.content.card.status] : []))

describe("tasklet scrollback revisions", () => {
	it("reopens an already printed same-ID tasklet at the live tail and archives only displaced terminal revisions", async () => {
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
		expect(view.lastFrame()?.split("Tasklet tl_reopen").at(-1)).not.toContain("old result")

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

	it("keeps live waiting tasklets mutable while the root and siblings continue", () => {
		let timeline!: ChatTimelineResult
		function Probe() {
			timeline = useChatTimeline({
				messages: [text("root"), tasklet("waiting"), text("sibling progress", 20)],
				showHeader: false,
				terminalColumns: 120,
				layoutRows: { liveViewportRows: 6, activeContentRows: 4, compactHistoryRows: 2 },
				shouldSuppressCardBody: () => false,
			})
			return <Text>probe</Text>
		}
		const view = render(<Probe />)
		expect(statuses(messageItems(timeline.staticItems))).toEqual([])
		expect(timeline.displayMessages).toHaveLength(3)
		view.unmount()
	})
})
