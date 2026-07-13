import { describe, expect, it, vi } from "vitest"
import { StateManager } from "@/core/storage/StateManager"
import { historyItemToSessionInfo, listLatestConversationHistoryItems } from "./sessionHistory.js"

vi.mock("@/core/storage/StateManager", () => ({
	StateManager: {
		get: vi.fn(),
	},
}))

const taskHistory = [
	{
		id: "task-older",
		ulid: "session-one",
		ts: 1_000,
		task: "Older task title",
		tokensIn: 0,
		tokensOut: 0,
		totalCost: 0,
		cwdOnTaskInitialization: "/workspace/one",
	},
	{
		id: "task-newer",
		ulid: "session-one",
		ts: 3_000,
		task: "Newer task title",
		tokensIn: 0,
		tokensOut: 0,
		totalCost: 0,
		cwdOnTaskInitialization: "/workspace/one",
	},
	{
		id: "task-two",
		ts: 2_000,
		task: "Second session",
		tokensIn: 0,
		tokensOut: 0,
		totalCost: 0,
		cwdOnTaskInitialization: "/workspace/two",
	},
]

describe("session history listing", () => {
	it("returns one latest persisted item per conversation in most-recent-first order", () => {
		vi.mocked(StateManager.get).mockReturnValue({
			getGlobalStateKey: vi.fn(() => taskHistory),
		} as any)

		expect(listLatestConversationHistoryItems()).toEqual([taskHistory[1], taskHistory[2]])
	})

	it("filters persisted sessions by workspace and exposes ACP session metadata", () => {
		vi.mocked(StateManager.get).mockReturnValue({
			getGlobalStateKey: vi.fn(() => taskHistory),
		} as any)

		const [historyItem] = listLatestConversationHistoryItems("/workspace/one")
		expect(historyItemToSessionInfo(historyItem)).toEqual({
			sessionId: "session-one",
			cwd: "/workspace/one",
			title: "Newer task title",
			updatedAt: "1970-01-01T00:00:03.000Z",
		})
	})
})
