import type { Controller } from "@/core/controller"
import { CardStatus, DiracMessageType } from "@shared/ExtensionMessage"
import type { TaskletActivitySummary, TaskletInventoryPage, TaskletTranscriptPage } from "@shared/taskletObservation"
import { Box } from "ink"
import { cleanup, render } from "ink-testing-library"
// biome-ignore lint/correctness/noUnusedImports: Classic JSX runtime requires React in scope.
import React from "react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { AgentPanelContent } from "./AgentPanelContent"

const mocks = vi.hoisted(() => ({
	input: undefined as ((input: string, key: import("ink").Key) => void) | undefined,
	inventory: vi.fn(),
	transcript: vi.fn(),
	terminalSize: { columns: 120, rows: 50 },
}))
vi.mock("ink", async (original) => ({
	...(await original<typeof import("ink")>()),
	useInput: (handler: typeof mocks.input) => {
		mocks.input = handler
	},
}))
vi.mock("../hooks/useTerminalSize", () => ({ useTerminalSize: () => mocks.terminalSize }))
vi.mock("@/core/controller/task/getTaskletInventory", () => ({ getTaskletInventory: mocks.inventory }))
vi.mock("@/core/controller/task/getTaskletTranscript", () => ({ getTaskletTranscript: mocks.transcript }))
const scope: TaskletActivitySummary = { rootTaskId: "root", sourceId: "live", availability: "live", activeCount: 1 }
const inventory: TaskletInventoryPage = {
	...scope,
	observedAt: 1,
	filter: "all",
	totalItems: 2,
	items: [
		{ taskletId: "child", title: "Trace events", state: "waiting_for_parent" },
		{ taskletId: "done", title: "Finished audit", state: "completed" },
	],
}
const transcript: TaskletTranscriptPage = {
	...scope,
	observedAt: 1,
	taskletId: "child",
	title: "Trace events",
	state: "waiting_for_parent",
	messages: [
		{
			id: "question",
			ts: 1,
			content: {
				type: DiracMessageType.CARD,
				card: {
					id: "question",
					header: "Choose direction",
					status: CardStatus.WAITING_FOR_INPUT,
					body: "Read-only question text",
				},
			},
		},
	],
	truncatedMessageIds: [],
	outcome: { kind: "completed", summary: "Separate durable result", at: 2, truncated: false },
}
const controller = {} as Controller
const key = (value: Partial<import("ink").Key>, text = "") => mocks.input?.(text, value as import("ink").Key)

describe("passive CLI tasklet view", () => {
	afterEach(cleanup)

	beforeEach(() => {
		mocks.terminalSize.columns = 120
		mocks.terminalSize.rows = 50
		mocks.inventory.mockReset().mockResolvedValue({ value: JSON.stringify(inventory) })
		mocks.transcript.mockReset().mockResolvedValue({ value: JSON.stringify(transcript) })
	})
	it.each([80, 60])("keeps long-title inventory states visible at %s columns", async (columns) => {
		mocks.terminalSize.columns = columns
		mocks.inventory.mockResolvedValue({
			value: JSON.stringify({
				...inventory,
				items: inventory.items.map((agent) => ({ ...agent, title: "長い調査名".repeat(16) })),
			}),
		})
		const view = render(
			<Box width={columns}>
				<AgentPanelContent controller={controller} scope={scope} availableRows={24} onClose={() => { }} />
			</Box>,
		)
		try {
			await vi.waitFor(() => expect(view.lastFrame()).toContain("2 total"))
			const lines = view.lastFrame()!.split("\n")
			expect(lines.some((line) => line.includes("長い") && line.includes("Waiting for parent"))).toBe(true)
			expect(lines.some((line) => line.includes("長い") && line.includes("Completed"))).toBe(true)
		} finally {
			view.unmount()
		}
	})

	it.each([80, 60])("keeps long transcript titles and the back hint on one row at %s columns", async (columns) => {
		mocks.terminalSize.columns = columns
		mocks.transcript.mockResolvedValue({
			value: JSON.stringify({
				...transcript,
				title: "ExtremelyLongAssignmentTitleForTerminalWidthRegressionWithoutSpacesAcrossTheScreen",
				outcome: { ...transcript.outcome, summary: "Transcript line\n".repeat(40) },
			}),
		})
		const view = render(
			<Box width={columns}>
				<AgentPanelContent controller={controller} scope={scope} availableRows={24} onClose={() => { }} />
			</Box>,
		)
		try {
			await vi.waitFor(() => expect(view.lastFrame()).toContain("Waiting for parent"))
			key({ return: true })
			await vi.waitFor(() => expect(view.lastFrame()).toContain("Transcript line"))
			const lines = view.lastFrame()!.split("\n")
			expect(lines.some((line) => line.includes("ExtremelyLong") && line.includes("(Esc to go back)"))).toBe(true)
			expect(lines).toHaveLength(24)
		} finally {
			view.unmount()
		}
	})

	it("reads all inventory then only the selected transcript; status updates do not refresh it", async () => {
		const view = render(<AgentPanelContent controller={controller} scope={scope} onClose={() => { }} />)
		await vi.waitFor(() => expect(view.lastFrame()).toContain("Waiting for parent"))
		expect(mocks.inventory).toHaveBeenCalledWith(
			controller,
			expect.objectContaining({ filter: "all", rootTaskId: "root", sourceId: "live" }),
		)
		expect(mocks.transcript).not.toHaveBeenCalled()
		key({ return: true })
		await vi.waitFor(() => expect(view.lastFrame()).toContain("Read-only question text"))
		expect(view.lastFrame()).toContain("Separate durable result")
		expect(mocks.transcript).toHaveBeenCalledWith(controller, expect.objectContaining({ taskletId: "child" }))
		view.rerender(<AgentPanelContent controller={controller} scope={{ ...scope, activeCount: 0 }} onClose={() => { }} />)
		await new Promise((resolve) => setTimeout(resolve, 20))
		expect(mocks.transcript).toHaveBeenCalledTimes(1)
		key({}, "yes")
		expect(mocks.transcript).toHaveBeenCalledTimes(1)
		key({}, "r")
		await vi.waitFor(() => expect(mocks.transcript).toHaveBeenCalledTimes(2))
		view.unmount()
	})
	it("reads the next bounded page explicitly and reports stale-cursor errors", async () => {
		mocks.inventory
			.mockResolvedValueOnce({ value: JSON.stringify({ ...inventory, nextCursor: "next" }) })
			.mockRejectedValueOnce(new Error("Stale cursor; refresh"))
		const view = render(<AgentPanelContent controller={controller} scope={scope} onClose={() => { }} />)
		await vi.waitFor(() => expect(view.lastFrame()).toContain("n next"))
		key({}, "n")
		await vi.waitFor(() => expect(view.lastFrame()).toContain("Stale cursor"))
		expect(mocks.inventory).toHaveBeenLastCalledWith(controller, expect.objectContaining({ cursor: "next" }))
		key({}, "r")
		await vi.waitFor(() => expect(mocks.inventory).toHaveBeenCalledTimes(3))
		expect(mocks.inventory).toHaveBeenLastCalledWith(controller, expect.objectContaining({ cursor: undefined }))
		view.unmount()
	})
	it("discards an old source response after selection changes", async () => {
		let resolveOld!: (value: { value: string }) => void
		mocks.inventory.mockImplementationOnce(
			() =>
				new Promise((resolve) => {
					resolveOld = resolve
				}),
		)
		const view = render(<AgentPanelContent controller={controller} scope={scope} onClose={() => { }} />)
		await vi.waitFor(() => expect(mocks.inventory).toHaveBeenCalledOnce())
		const nextScope = { ...scope, rootTaskId: "next", sourceId: "next-live" }
		mocks.inventory.mockResolvedValueOnce({ value: JSON.stringify({ ...inventory, ...nextScope, items: [], totalItems: 0 }) })
		view.rerender(<AgentPanelContent controller={controller} scope={nextScope} onClose={() => { }} />)
		await vi.waitFor(() => expect(view.lastFrame()).toContain("No recorded agents"))
		resolveOld({ value: JSON.stringify(inventory) })
		await new Promise((resolve) => setTimeout(resolve, 20))
		expect(view.lastFrame()).not.toContain("Trace events")
		view.unmount()
	})
	it("discloses complete root and sibling communication locally without IDs, requests, or child controls", async () => {
		mocks.terminalSize.rows = 16
		const cards = [
			{
				id: "opaque-card-id",
				header: "Dirac → Curie · Guidance",
				status: CardStatus.SUCCESS,
				renderType: "markdown" as const,
				communication: { actor: "Dirac", detail: "Queued · opaque-publication-id" },
				body: `First root message\n\n\`\`\`bash\nnpm run deploy\n\`\`\`\n${"long content\n".repeat(30)}Root ending`,
			},
			{
				id: "opaque-sibling-id",
				header: "Curie → Planck · Message",
				status: CardStatus.SUCCESS,
				renderType: "text" as const,
				communication: { actor: "Curie" },
				requireApproval: true,
				actions: [{ label: "Approve", value: "approve" }],
				body: "Anchor§literal <button>Approve</button>\nAuthored hash: deadbeef",
			},
		]
		const onClose = vi.fn()
		const view = render(<AgentPanelContent controller={controller} communicationCards={cards} onClose={onClose} />)
		await vi.waitFor(() => expect(view.lastFrame()).toContain("No task selected."))
		key({}, "c")
		await vi.waitFor(() => expect(view.lastFrame()).toContain("First root message"))
		expect(view.lastFrame()).toContain("npm run deploy")
		expect(view.lastFrame()).not.toContain("```")
		expect(view.lastFrame()).not.toContain("\u001b]8;")
		expect(view.lastFrame()).not.toContain("Root ending")
		expect(view.lastFrame()).not.toMatch(/opaque-card-id|opaque-publication-id|opaque-sibling-id/)
		for (let index = 0; index < 6; index++) {
			key({ pageDown: true })
			await new Promise((resolve) => setTimeout(resolve, 10))
		}
		expect(view.lastFrame()).toContain("Root ending")
		expect(view.lastFrame()).toContain("Curie → Planck")
		expect(view.lastFrame()).toContain("Anchor§literal <button>Approve</button>")
		expect(view.lastFrame()).toContain("Authored hash: deadbeef")
		key({}, "approve")
		expect(mocks.inventory).not.toHaveBeenCalled()
		expect(mocks.transcript).not.toHaveBeenCalled()
		key({ escape: true })
		expect(onClose).not.toHaveBeenCalled()
		view.unmount()
	})
})
