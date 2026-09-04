import { CardKind, CardStatus, type DiracMessage, DiracMessageType, type ExtensionState } from "@shared/ExtensionMessage"
import { act, renderHook } from "@testing-library/react"
import { useChatStore } from "../chatStore"

function permissionCardMessage(status: CardStatus, collapsed: boolean): DiracMessage {
	return {
		id: "message-1",
		ts: 1,
		content: {
			type: DiracMessageType.CARD,
			card: {
				id: "card-1",
				kind: CardKind.GENERIC,
				header: "Execute: git add .",
				status,
				body: "git add .",
				renderType: "text",
				requireApproval: true,
				collapsed,
			},
		},
	}
}

describe("useChatStore", () => {
	beforeEach(() => {
		useChatStore.setState({
			diracMessages: [],
			messageIndexById: new Map(),
			presentationSurfaceId: undefined,
			presentationOffset: -1,
			presentationRevision: 0,
			presentationAppends: new Map(),
			visibleMessageIds: [],
			visibleMessageIdSet: new Set(),
			goal: undefined,
			uiActionState: undefined,
			activeVoiceStreamId: undefined,
			isApiRequestActive: false,
			taskStatus: undefined,
			cardCollapsedStates: {},
			cardUserToggledStates: {},
		})
	})

	it("should initialize with empty messages", () => {
		const { result } = renderHook(() => useChatStore())
		expect(result.current.diracMessages).toEqual([])
	})

	it("should set messages", () => {
		const { result } = renderHook(() => useChatStore())
		const messages: DiracMessage[] = [
			{
				id: "message-1",
				ts: 1,
				content: { type: DiracMessageType.MARKDOWN, content: "hello" },
			},
		]

		act(() => {
			result.current.setDiracMessages(messages)
		})

		expect(result.current.diracMessages).toEqual(messages)
	})

	it("applies task fields from a shared extension-state snapshot", () => {
		const messages = [permissionCardMessage(CardStatus.RUNNING, false)]
		const uiActionState = {
			globalButtons: [],
			cardButtons: [],
		} as ExtensionState["uiActionState"]
		const extensionState = {
			diracMessages: messages,
			uiActionState,
			activeVoiceStreamId: "message-1",
			isApiRequestActive: true,
			taskStatus: "streaming_text",
		} as ExtensionState

		useChatStore.getState().applyExtensionState(extensionState)

		expect(useChatStore.getState()).toMatchObject({
			diracMessages: messages,
			uiActionState,
			activeVoiceStreamId: "message-1",
			isApiRequestActive: true,
			taskStatus: "streaming_text",
		})
	})

	it("preserves Goal state in partial updates and clears it from an explicit tombstone", () => {
		const goal = { id: "goal-1" } as ExtensionState["goal"]
		useChatStore.getState().applyExtensionState({ goal })

		useChatStore.getState().applyExtensionState({ taskStatus: "streaming_text" })
		expect(useChatStore.getState().goal).toBe(goal)

		useChatStore.getState().applyExtensionState({ goal: null })
		expect(useChatStore.getState().goal).toBeUndefined()
	})

	it("should track collapsed cards and user toggles", () => {
		const { result } = renderHook(() => useChatStore())

		act(() => {
			result.current.setCardCollapsedState("card-1", true, true)
		})

		expect(result.current.cardCollapsedStates).toEqual({ "card-1": true })
		expect(result.current.cardUserToggledStates).toEqual({ "card-1": true })
	})

	it("should clear collapsed card state", () => {
		const { result } = renderHook(() => useChatStore())

		act(() => {
			result.current.setCardCollapsedState("card-1", true, true)
			result.current.clearCardCollapsedStates()
		})

		expect(result.current.cardCollapsedStates).toEqual({})
		expect(result.current.cardUserToggledStates).toEqual({})
	})

	it("forces a resolved permission card closed even when the user opened it while pending", () => {
		const { setDiracMessages, setCardCollapsedState } = useChatStore.getState()
		setDiracMessages([permissionCardMessage(CardStatus.WAITING_FOR_INPUT, false)])
		setCardCollapsedState("card-1", false, true)

		useChatStore.getState().setDiracMessages([permissionCardMessage(CardStatus.SUCCESS, true)])

		expect(useChatStore.getState().cardCollapsedStates["card-1"]).toBe(true)
		expect(useChatStore.getState().cardUserToggledStates["card-1"]).toBe(false)
	})

	it("preserves a user reopening a permission card after it was resolved", () => {
		const resolvedCard = permissionCardMessage(CardStatus.SUCCESS, true)
		useChatStore.getState().setDiracMessages([resolvedCard])
		useChatStore.getState().setCardCollapsedState("card-1", false, true)

		useChatStore.getState().setDiracMessages([resolvedCard])

		expect(useChatStore.getState().cardCollapsedStates["card-1"]).toBe(false)
		expect(useChatStore.getState().cardUserToggledStates["card-1"]).toBe(true)
	})

	it("updates session cost from structured subagent snapshots without changing main context usage", () => {
		const usage = { source: "subagents", tokensIn: 100, tokensOut: 20, cacheWrites: 0, cacheReads: 0, cost: 0.5 }
		const main: DiracMessage = {
			id: "main", ts: 1,
			content: { type: DiracMessageType.API_STATUS, status: { tokensIn: 10, tokensOut: 5, cost: 0.25 } },
		}
		const subagent: DiracMessage = {
			id: "subagent", ts: 2,
			content: {
				type: DiracMessageType.CARD, card: {
					id: "usage", header: "Localized label", body: "Not JSON", renderType: "text",
					status: CardStatus.RUNNING, rawOutput: usage,
				}
			},
		}
		useChatStore.getState().applyExtensionState({
			diracMessages: [main, subagent], presentationSurfaceId: "task-1", presentationOffset: -1,
		})
		expect(useChatStore.getState().apiMetrics.totalCost).toBe(0.75)
		useChatStore.getState().applyPresentationBatch({
			surfaceId: "task-1",
			operations: [{ offset: 0, type: "patch_card", id: subagent.id, patch: { rawOutput: { ...usage, cost: 1 } } }],
		})
		expect(useChatStore.getState().apiMetrics.totalCost).toBe(1.25)
		expect(useChatStore.getState().lastApiReqInfo?.tokensIn).toBe(10)
	})


	it("applies contiguous patches by ID without replacing an unchanged large body", () => {
		const task: DiracMessage = {
			id: "task",
			ts: 0,
			content: { type: DiracMessageType.MARKDOWN, content: "task" },
		}
		const card = permissionCardMessage(CardStatus.RUNNING, false)
		const request = "request-" + "y".repeat(2 * 1024 * 1024)
		const apiStatus: DiracMessage = {
			id: "api-status",
			ts: 2,
			content: {
				type: DiracMessageType.API_STATUS,
				status: {
					request,
					retryStatus: { attempt: 1, maxAttempts: 3, delaySec: 2 },
				},
			},
		}
		card.content.type === DiracMessageType.CARD && (card.content.card.body = "x".repeat(2 * 1024 * 1024))
		useChatStore.getState().applyExtensionState({
			diracMessages: [task, card, apiStatus],
			presentationSurfaceId: "task-1",
			presentationOffset: -1,
		})
		const messagesBefore = useChatStore.getState().diracMessages
		const bodyBefore = (messagesBefore[1].content as any).card.body

		const result = useChatStore.getState().applyPresentationBatch({
			surfaceId: "task-1",
			operations: [
				{
					offset: 0,
					type: "patch_card",
					id: card.id,
					patch: { status: CardStatus.SUCCESS },
				},
			],
		})

		expect(result).toBe("applied")
		expect(useChatStore.getState().diracMessages).toBe(messagesBefore)
		expect((useChatStore.getState().diracMessages[1].content as any).card.body).toBe(bodyBefore)
		expect(useChatStore.getState().presentationOffset).toBe(0)
		expect(
			useChatStore.getState().applyPresentationBatch({
				surfaceId: "task-1",
				operations: [
					{
						offset: 0,
						type: "patch_card",
						id: card.id,
						patch: { header: "duplicate" },
					},
				],
			}),
		).toBe("applied")
		expect((useChatStore.getState().diracMessages[1].content as any).card.header).not.toBe("duplicate")

		expect(
			useChatStore.getState().applyPresentationBatch({
				surfaceId: "task-1",
				operations: [
					{
						offset: 1,
						type: "patch_api_status",
						id: apiStatus.id,
						patch: { cost: 0.25 },
						deletions: ["retryStatus"],
					},
				],
			}),
		).toBe("applied")
		const patchedApiStatus = useChatStore.getState().diracMessages[2]
		expect(patchedApiStatus.content.type).toBe(DiracMessageType.API_STATUS)
		if (patchedApiStatus.content.type !== DiracMessageType.API_STATUS) throw new Error("Expected API status")
		expect(patchedApiStatus.content.status.request).toBe(request)
		expect(patchedApiStatus.content.status.retryStatus).toBeUndefined()
		expect(patchedApiStatus.content.status.cost).toBe(0.25)
	})

	it("records append chunks without replacing the affected message and rejects gaps and stale surfaces", () => {
		const stream: DiracMessage = {
			id: "stream",
			ts: 1,
			content: { type: DiracMessageType.MARKDOWN, content: "prefix" },
		}
		useChatStore.getState().applyExtensionState({
			diracMessages: [
				{
					id: "task",
					ts: 0,
					content: { type: DiracMessageType.MARKDOWN, content: "task" },
				},
				stream,
			],
			presentationSurfaceId: "task-1",
			presentationOffset: 4,
		})
		const streamBefore = useChatStore.getState().diracMessages[1]

		expect(
			useChatStore.getState().applyPresentationBatch({
				surfaceId: "other-task",
				operations: [{ offset: 5, type: "append_markdown", id: stream.id, text: "wrong" }],
			}),
		).toBe("wrong_surface")
		expect(
			useChatStore.getState().applyPresentationBatch({
				surfaceId: "task-1",
				operations: [{ offset: 6, type: "append_markdown", id: stream.id, text: "gap" }],
			}),
		).toBe("gap")
		expect(
			useChatStore.getState().applyPresentationBatch({
				surfaceId: "task-1",
				operations: [
					{ offset: 5, type: "append_markdown", id: stream.id, text: "-tail" },
					{ offset: 6, type: "append_markdown", id: stream.id, text: "-more" },
				],
			}),
		).toBe("applied")

		expect(useChatStore.getState().diracMessages[1]).toBe(streamBefore)
		expect((streamBefore.content as any).content).toBe("prefix")
		expect(useChatStore.getState().presentationAppends.get(stream.id)).toEqual({
			revision: 2,
			chunks: ["-tail", "-more"],
		})

		expect(
			useChatStore.getState().applyPresentationBatch({
				surfaceId: "task-1",
				operations: [{ offset: 7, type: "patch_markdown", id: stream.id, patch: { images: ["image"] } }],
			}),
		).toBe("applied")
		const materialized = useChatStore.getState().diracMessages[1]
		expect(materialized.content.type).toBe(DiracMessageType.MARKDOWN)
		if (materialized.content.type !== DiracMessageType.MARKDOWN) throw new Error("Expected markdown")
		expect(materialized.content.content).toBe("prefix-tail-more")
		expect(useChatStore.getState().presentationAppends.has(stream.id)).toBe(false)
	})
})
