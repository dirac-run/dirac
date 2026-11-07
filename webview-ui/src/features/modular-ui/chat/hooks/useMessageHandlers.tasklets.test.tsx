import {
	type Card,
	CardStatus,
	type DiracMessage,
	DiracMessageType,
	TaskStatus,
	UIActionButtonType,
	type UIActionState,
} from "@shared/ExtensionMessage"
import { AskResponseRequest, type NewTaskRequest, SteerTaskRequest, type TaskletInventoryRequest } from "@shared/proto/dirac/task"
import { createTaskletPresentationCard } from "@shared/taskletPresentation"
import type { TaskletInventoryPage } from "@shared/taskletObservation"
import { DiracAskResponse } from "@shared/WebviewMessage"
import { act, cleanup, renderHook } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { useChatStore } from "@/features/chat/store/chatStore"
import { useSettingsStore } from "@/features/settings/store/settingsStore"
import { InteractionState, InteractionStateProvider, useInteractionState } from "../context/InteractionStateContext"
import type { ChatState } from "../types/chatTypes"
import { useChatState } from "./useChatState"
import { useMessageHandlers } from "./useMessageHandlers"

const taskService = vi.hoisted(() => ({
	newTask: vi.fn<(request: NewTaskRequest) => Promise<void>>().mockResolvedValue(undefined),
	askResponse: vi.fn<(request: AskResponseRequest) => Promise<void>>().mockResolvedValue(undefined),
	steerTask: vi.fn<(request: SteerTaskRequest) => Promise<void>>().mockResolvedValue(undefined),
	getTaskletInventory: vi.fn<(request: TaskletInventoryRequest) => Promise<{ value: string }>>(),
}))
const goalService = vi.hoisted(() => ({ sendGoalMessage: vi.fn() }))

vi.mock("@/shared/api/grpc-client", () => ({
	TaskServiceClient: taskService,
	GoalServiceClient: goalService,
}))

function cardMessage(card: Card): DiracMessage {
	return { id: card.id, ts: 1, content: { type: DiracMessageType.CARD, card } }
}

const root: DiracMessage = {
	id: "root-task",
	ts: 0,
	content: { type: DiracMessageType.MARKDOWN, role: "user", content: "Review the implementation" },
}
const spawn = cardMessage({
	id: "root-spawn",
	toolName: "tasklets",
	header: "Tasklet started",
	status: CardStatus.SUCCESS,
	renderType: "text",
})
const waitingChild = cardMessage(
	createTaskletPresentationCard({
		taskletId: "child-review",
		title: "Review implementation",
		prompt: "Inspect the public interface",
		createdAt: 1,
		status: "waiting",
		communications: ["May I run the verification command?"],
		activity: [],
	}),
)
const escalation = cardMessage({
	id: "root-escalation",
	toolName: "execute_command",
	header: "Approve the tasklet verification command",
	status: CardStatus.WAITING_FOR_INPUT,
	renderType: "text",
	requireApproval: true,
	actions: [{ label: "Approve", value: DiracAskResponse.APPROVE, primary: true }],
})

function runningActions(activeCardId?: string): UIActionState {
	return {
		activeCardId,
		globalButtons: [{ label: "Cancel", action: UIActionButtonType.CANCEL }],
		cardButtons: [],
		sendingDisabled: false,
	}
}

function hydrate(uiActionState = runningActions(), withGoal = false) {
	useChatStore.getState().applyExtensionState({
		goal: withGoal
			? {
				id: root.id,
				status: "waiting",
				followUpActive: false,
				hasLocalExecution: true,
				objective: { markdown: "Review the implementation", revision: 1, updatedAt: 0 },
				createdAt: 0,
				updatedAt: 1,
				wallDurationMs: 1,
				activeDurationMs: 1,
				accounting: {},
				mode: "act",
				modeSwitchingDisabled: true,
				modeSwitchingExplanation: "Goal pursuit is Act-only",
			}
			: undefined,
		diracMessages: [root, spawn, waitingChild],
		presentationSurfaceId: root.id,
		presentationOffset: -1,
		// The executing root remains busy even though spawn has finished and the child awaits its parent.
		taskStatus: TaskStatus.EXECUTING_TOOL,
		isApiRequestActive: false,
		uiActionState,
	})
}

function mountHandlers() {
	return renderHook(
		() => {
			// Use the actual composer state contract, rather than an incomplete cast or mocked setters.
			const chatState: ChatState = useChatState()
			const handlers = useMessageHandlers(chatState)
			const { state } = useInteractionState()
			return { chatState, handlers, interactionState: state }
		},
		{ wrapper: InteractionStateProvider },
	)
}

function publishRootEscalation() {
	act(() => {
		useChatStore.getState().applyExtensionState({
			// Keep the informational child last: routing must follow activeCardId, not the latest card.
			diracMessages: [root, spawn, escalation, waitingChild],
			taskStatus: TaskStatus.AWAITING_USER_INPUT,
			uiActionState: {
				activeCardId: escalation.id,
				globalButtons: [],
				cardButtons: [{ label: "Approve", action: UIActionButtonType.APPROVE }],
				sendingDisabled: false,
			},
		})
	})
}

beforeEach(() => {
	vi.clearAllMocks()
	useChatStore.setState(useChatStore.getInitialState(), true)
	// Preserve the real settings shape; only specialize fields read by the hook/provider.
	useSettingsStore.setState({ ...useSettingsStore.getInitialState(), mode: "act", expandTaskHeader: true }, true)
})

afterEach(() => {
	cleanup()
	vi.restoreAllMocks()
	useChatStore.setState(useChatStore.getInitialState(), true)
	useSettingsStore.setState(useSettingsStore.getInitialState(), true)
})

describe("useMessageHandlers tasklet routing", () => {
	it.each([
		undefined,
		spawn.id,
	])("steers the executing root and leaves the composer enabled after first and second wake messages (active card: %s)", async (activeCardId) => {
		hydrate(runningActions(activeCardId))
		const { result } = mountHandlers()

		expect(result.current.interactionState).toBe(InteractionState.RUNNING)
		expect(result.current.chatState.sendingDisabled).toBe(false)
		expect(result.current.chatState.lastMessage).toEqual(waitingChild)

		for (const [index, text] of ["First wake: inspect the tests", "Second wake: summarize the findings"].entries()) {
			act(() => result.current.chatState.setInputValue(`  ${text}  `))
			await act(async () => {
				await result.current.handlers.handleSendMessage(result.current.chatState.inputValue, [], [])
			})

			expect(taskService.steerTask).toHaveBeenNthCalledWith(index + 1, SteerTaskRequest.create({ text }))
			expect(taskService.steerTask).toHaveBeenCalledTimes(index + 1)
			expect(taskService.newTask).not.toHaveBeenCalled()
			expect(taskService.askResponse).not.toHaveBeenCalled()
			expect(result.current.chatState.inputValue).toBe("")
			expect(result.current.chatState.sendingDisabled).toBe(false)
			expect(result.current.interactionState).toBe(InteractionState.RUNNING)
		}
		expect(useSettingsStore.getState().expandTaskHeader).toBe(false)
	})

	it.each([
		false,
		true,
	])("routes a text response to the actual shared root escalation (Goal: %s), never the waiting child's card", async (withGoal) => {
		hydrate(runningActions(), withGoal)
		const { result } = mountHandlers()
		publishRootEscalation()

		expect(result.current.interactionState).toBe(InteractionState.AWAITING_RESPONSE)
		expect(result.current.chatState.lastMessage?.id).toBe(waitingChild.id)
		await act(async () => {
			await result.current.handlers.handleSendMessage("Use the focused verification only", [], [])
		})

		expect(taskService.askResponse).toHaveBeenCalledExactlyOnceWith(
			AskResponseRequest.create({
				cardId: escalation.id,
				responseType: DiracAskResponse.MESSAGE,
				text: "Use the focused verification only",
				images: [],
				files: [],
			}),
		)
		expect(taskService.steerTask).not.toHaveBeenCalled()
		expect(taskService.newTask).not.toHaveBeenCalled()
	})

	it.each(["active card", "explicit card"])("routes approval through askResponse with the root %s identity", async (source) => {
		hydrate()
		const { result } = mountHandlers()
		publishRootEscalation()

		await act(async () => {
			await result.current.handlers.executeButtonAction(
				DiracAskResponse.APPROVE,
				undefined,
				undefined,
				undefined,
				undefined,
				source === "explicit card" ? escalation.id : undefined,
			)
		})

		expect(taskService.askResponse).toHaveBeenCalledExactlyOnceWith(
			AskResponseRequest.create({
				cardId: escalation.id,
				responseType: DiracAskResponse.APPROVE,
			}),
		)
		expect(taskService.steerTask).not.toHaveBeenCalled()
		expect(taskService.newTask).not.toHaveBeenCalled()
	})

	it.each([DiracAskResponse.APPROVE, "proceed", "retry"] as const)(
		"routes a global cancelled-task %s as lifecycle input without approving a card",
		async (action) => {
			hydrate()
			useChatStore.getState().applyExtensionState({
				taskStatus: TaskStatus.CANCELLED,
				uiActionState: {
					globalButtons: [{ label: "Resume", action: UIActionButtonType.APPROVE, primary: true }],
					cardButtons: [],
					sendingDisabled: false,
				},
			})
			const { result } = mountHandlers()
			expect(result.current.interactionState).toBe(InteractionState.AWAITING_RESPONSE)
			await act(async () => {
				await result.current.handlers.executeButtonAction(action)
			})
			expect(taskService.askResponse).toHaveBeenCalledExactlyOnceWith(
				AskResponseRequest.create({ cardId: "", responseType: DiracAskResponse.MESSAGE }),
			)
			expect(taskService.steerTask).not.toHaveBeenCalled()
			expect(taskService.newTask).not.toHaveBeenCalled()
		},
	)

	it("preserves the draft and attachments when the global Resume action continues a task", async () => {
		hydrate()
		useChatStore.getState().applyExtensionState({
			taskStatus: TaskStatus.CANCELLED,
			uiActionState: {
				globalButtons: [{ label: "Resume", action: UIActionButtonType.APPROVE, primary: true }],
				cardButtons: [],
				sendingDisabled: false,
			},
		})
		const { result } = mountHandlers()
		await act(async () => {
			await result.current.handlers.executeButtonAction(
				DiracAskResponse.APPROVE,
				undefined,
				"  Continue with these files  ",
				["image-data"],
				["src/example.ts"],
			)
		})
		expect(taskService.askResponse).toHaveBeenCalledExactlyOnceWith(
			AskResponseRequest.create({
				cardId: "",
				responseType: DiracAskResponse.MESSAGE,
				text: "Continue with these files",
				images: ["image-data"],
				files: ["src/example.ts"],
			}),
		)
	})

	it.each([
		{ label: "image", text: "Inspect this screenshot", images: ["data:image/png;base64,draft"], files: [] },
		{ label: "file", text: "Inspect this file", images: [], files: ["src/example.ts"] },
		{ label: "attachment-only", text: "", images: [], files: ["src/example.ts"] },
	])("documents the current RUNNING text-only limitation for $label guidance without discarding the draft", async ({
		text,
		images,
		files,
	}) => {
		hydrate()
		const { result } = mountHandlers()
		const consoleError = vi.spyOn(console, "error").mockImplementation(() => { })
		act(() => {
			result.current.chatState.setInputValue(text)
			result.current.chatState.setSelectedImages(images)
			result.current.chatState.setSelectedFiles(files)
		})

		// Existing behavior intentionally rejects attachments rather than rerouting them to newTask/askResponse.
		await act(async () => {
			await result.current.handlers.handleSendMessage(text, images, files)
		})

		expect(consoleError).toHaveBeenCalledExactlyOnceWith(
			"[ChatView] Failed to send message:",
			expect.objectContaining({ message: "Mid-turn guidance currently supports text only" }),
		)
		expect(taskService.steerTask).not.toHaveBeenCalled()
		expect(taskService.newTask).not.toHaveBeenCalled()
		expect(taskService.askResponse).not.toHaveBeenCalled()
		expect(result.current.chatState.inputValue).toBe(text)
		expect(result.current.chatState.selectedImages).toEqual(images)
		expect(result.current.chatState.selectedFiles).toEqual(files)
		expect(result.current.chatState.sendingDisabled).toBe(false)
		expect(result.current.interactionState).toBe(InteractionState.RUNNING)
	})
})

function inventoryPage(overrides: Partial<TaskletInventoryPage> = {}): TaskletInventoryPage {
	return {
		rootTaskId: root.id,
		sourceId: "host-1",
		availability: "live",
		observedAt: 1000,
		filter: "active",
		totalItems: 16,
		items: Array.from({ length: 16 }, (_, index) => ({
			taskletId: `tasklet-${index}`,
			title: `Worker ${index}`,
			state: index === 0 ? "waiting_for_parent" : "running",
		})),
		...overrides,
	}
}

function localSnapshotText(): string[] {
	return [...useChatStore.getState().localObservationMessages.values()].map((entry) => entry.text)
}

describe("local /agents routing", () => {
	beforeEach(() => {
		taskService.getTaskletInventory.mockReset().mockResolvedValue({ value: JSON.stringify(inventoryPage()) })
	})

	it.each([false, true])("prints a frozen sixteen-agent snapshot without sending model input (Goal: %s)", async (withGoal) => {
		hydrate(runningActions(), withGoal)
		const before = [...useChatStore.getState().diracMessages]
		const { result } = mountHandlers()
		act(() => {
			result.current.chatState.setInputValue("/agents")
			result.current.chatState.setSendingDisabled(true)
		})
		await act(async () => result.current.handlers.handleSendMessage("/agents", [], []))
		expect(localSnapshotText()).toHaveLength(1)
		expect(localSnapshotText()[0]).toContain("16 active")
		expect(localSnapshotText()[0]).toContain("Worker 0 — Waiting for parent")
		expect(localSnapshotText()[0]).toContain("Worker 15 — Running")
		expect(useChatStore.getState().diracMessages).toEqual(before)
		expect(taskService.steerTask).not.toHaveBeenCalled()
		expect(taskService.newTask).not.toHaveBeenCalled()
		expect(taskService.askResponse).not.toHaveBeenCalled()
		expect(goalService.sendGoalMessage).not.toHaveBeenCalled()
		expect(result.current.chatState.inputValue).toBe("")
		expect(result.current.chatState.sendingDisabled).toBe(true)

		taskService.getTaskletInventory.mockResolvedValueOnce({ value: JSON.stringify(inventoryPage({ items: [], totalItems: 0 })) })
		await act(async () => result.current.handlers.handleSendMessage("/agents", [], []))
		expect(localSnapshotText()).toHaveLength(2)
		expect(localSnapshotText()[0]).toContain("16 active")
		expect(localSnapshotText()[1]).toContain("No active agents.")
	})

	it.each([false, true])("does not answer an active escalation from either send route (Goal: %s)", async (withGoal) => {
		hydrate(runningActions(escalation.id), withGoal)
		useChatStore.getState().applyExtensionState({
			taskStatus: TaskStatus.AWAITING_USER_INPUT,
			uiActionState: { activeCardId: escalation.id, globalButtons: [], cardButtons: [{ label: "Approve", action: UIActionButtonType.APPROVE }], sendingDisabled: false },
		})
		const { result } = mountHandlers()
		await act(async () => result.current.handlers.handleSendMessage("/agents", [], []))
		await act(async () => result.current.handlers.executeButtonAction(DiracAskResponse.APPROVE, undefined, "/agents", [], []))
		expect(taskService.getTaskletInventory).toHaveBeenCalledTimes(2)
		expect(taskService.askResponse).not.toHaveBeenCalled()
		expect(taskService.steerTask).not.toHaveBeenCalled()
		expect(goalService.sendGoalMessage).not.toHaveBeenCalled()
		expect(useChatStore.getState().uiActionState?.activeCardId).toBe(escalation.id)
	})

	it("retains quoted and attached drafts instead of sending or discarding them", async () => {
		hydrate()
		const { result } = mountHandlers()
		act(() => {
			result.current.chatState.setInputValue("/agents")
			result.current.chatState.setSelectedFiles(["src/example.ts"])
			result.current.chatState.setActiveQuote("Keep this context")
		})
		await act(async () => result.current.handlers.handleSendMessage("/agents", [], ["src/example.ts"]))
		expect(localSnapshotText()[0]).toContain("your draft has been kept")
		expect(result.current.chatState.inputValue).toBe("/agents")
		expect(result.current.chatState.selectedFiles).toEqual(["src/example.ts"])
		expect(result.current.chatState.activeQuote).toBe("Keep this context")
		expect(taskService.getTaskletInventory).not.toHaveBeenCalled()
		expect(taskService.askResponse).not.toHaveBeenCalled()
		expect(taskService.steerTask).not.toHaveBeenCalled()
	})

	it("reports saved-history availability without claiming zero running agents", async () => {
		hydrate()
		taskService.getTaskletInventory.mockResolvedValueOnce({ value: JSON.stringify(inventoryPage({ availability: "saved", items: [], totalItems: 0 })) })
		const { result } = mountHandlers()
		await act(async () => result.current.handlers.handleSendMessage("/agents", [], []))
		expect(localSnapshotText()[0]).toContain("live agent activity is unavailable")
		expect(localSnapshotText()[0]).not.toContain("No active agents")
	})

	it("renders read failures locally without falling through to steering", async () => {
		hydrate()
		taskService.getTaskletInventory.mockRejectedValueOnce(new Error("Stale inventory cursor"))
		const { result } = mountHandlers()
		await act(async () => result.current.handlers.handleSendMessage("/agents", [], []))
		expect(localSnapshotText()[0]).toBe("Could not read agents: Stale inventory cursor")
		expect(taskService.steerTask).not.toHaveBeenCalled()
		expect(taskService.askResponse).not.toHaveBeenCalled()
	})

	it("discards an in-flight read after switching away and back to the same root", async () => {
		hydrate()
		let resolveRead!: (value: { value: string }) => void
		taskService.getTaskletInventory.mockReturnValueOnce(new Promise((resolve) => { resolveRead = resolve }))
		const { result } = mountHandlers()
		let read!: Promise<void>
		act(() => { read = result.current.handlers.handleSendMessage("/agents", [], []) })
		act(() => {
			useChatStore.getState().applyExtensionState({ diracMessages: [], presentationSurfaceId: "other" })
			hydrate()
		})
		await act(async () => {
			resolveRead({ value: JSON.stringify(inventoryPage()) })
			await read
		})
		expect(localSnapshotText()).toEqual([])
		expect(taskService.steerTask).not.toHaveBeenCalled()
	})

	it("prints only one bounded page with an explicit remaining-agents hint", async () => {
		hydrate()
		const page = inventoryPage({ totalItems: 100, nextCursor: "page-2" })
		taskService.getTaskletInventory.mockResolvedValueOnce({ value: JSON.stringify(page) })
		const { result } = mountHandlers()
		await act(async () => result.current.handlers.handleSendMessage("/agents", [], []))
		expect(taskService.getTaskletInventory).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ rootTaskId: root.id, filter: "active", limit: 50 }))
		expect(localSnapshotText()).toHaveLength(1)
		expect(localSnapshotText()[0]).toContain("Showing 16 of 100 active agents")
		expect(localSnapshotText()[0]).toContain("Ask Dirac about the remaining agents")
	})
})
