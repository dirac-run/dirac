import {
	type Card,
	CardStatus,
	type DiracMessage,
	DiracMessageType,
	TaskStatus,
	UIActionButtonType,
	type UIActionState,
} from "@shared/ExtensionMessage"
import { AskResponseRequest, type NewTaskRequest, SteerTaskRequest } from "@shared/proto/dirac/task"
import { createTaskletPresentationCard } from "@shared/taskletPresentation"
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
}))

vi.mock("@/shared/api/grpc-client", () => ({
	TaskServiceClient: taskService,
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
					children: [],
					pendingInteractionCount: 1,
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
		const consoleError = vi.spyOn(console, "error").mockImplementation(() => {})
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
