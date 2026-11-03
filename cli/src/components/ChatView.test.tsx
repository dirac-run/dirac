/**
 * Tests for ChatView component exit and cleanup behavior
 *
 * These tests verify that when the user exits (via shutdown event or other means),
 * the input field is properly hidden before the app terminates.
 */

import { DiracMessageType, TaskStatus } from "@shared/ExtensionMessage"
import { DiracAskResponse } from "@shared/WebviewMessage"
import { Text } from "ink"
import { render } from "ink-testing-library"
import React from "react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { QUOTES } from "@/shared/quotes"
import { version as CLI_VERSION } from "../../package.json"
import { useTaskContext, useTaskState } from "../context/TaskContext"
import { useIsSpinnerActive } from "../hooks/useStateSubscriber"
import { ChatView } from "./ChatView"

const capturedInput = vi.hoisted(() => ({ handler: null as ((input: string, key: import("ink").Key) => void) | null }))
vi.mock("ink", async (importOriginal) => {
	const actual = await importOriginal<typeof import("ink")>()
	return {
		...actual,
		useInput: (handler: (input: string, key: import("ink").Key) => void) => {
			capturedInput.handler = handler
		},
	}
})

let forceRuntimeProcessing = false
vi.mock("../hooks/useChatTask", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../hooks/useChatTask")>()
	return {
		useChatTask: (props: Parameters<typeof actual.useChatTask>[0]) => {
			const state = actual.useChatTask(props)
			return { ...state, isProcessing: forceRuntimeProcessing || state.isProcessing }
		},
	}
})

type ChatInputProps = Parameters<typeof import("../hooks/useChatInputHandler").useChatInputHandler>[0]
let latestChatInputProps: ChatInputProps
vi.mock("../hooks/useChatInputHandler", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../hooks/useChatInputHandler")>()
	return {
		useChatInputHandler: (props: ChatInputProps) => {
			latestChatInputProps = props
			return actual.useChatInputHandler(props)
		},
	}
})

// Helper to wait for async state updates
const delay = (ms = 60) => new Promise((resolve) => setTimeout(resolve, ms))

// Type for our exit mock function
type ExitMockFn = ReturnType<typeof vi.fn> & (() => void)

// Track shutdown event state
const shutdownMockState = {
	listeners: [] as Array<() => void>,
	fire: () => {
		shutdownMockState.listeners.forEach((listener) => listener())
	},
	reset: () => {
		shutdownMockState.listeners = []
	},
}

vi.mock("ink-picture", () => ({
	TerminalInfoProvider: ({ children }: any) => children,
}))

// Mock the CLI shutdownEvent
vi.mock("../utils/shutdown", () => ({
	shutdownEvent: {
		event: (listener: () => void) => {
			shutdownMockState.listeners.push(listener)
			return {
				dispose: () => {
					const idx = shutdownMockState.listeners.indexOf(listener)
					if (idx >= 0) shutdownMockState.listeners.splice(idx, 1)
				},
			}
		},
		fire: () => shutdownMockState.fire(),
	},
}))

// Mock TaskContext
vi.mock("../context/TaskContext", () => ({
	useTaskState: vi.fn(() => ({
		diracMessages: [],
		mode: "act",
	})),
	useTaskContext: vi.fn(() => ({
		controller: null,
		setLastError: vi.fn(),
	})),
}))

// Mock useIsSpinnerActive hook
vi.mock("../hooks/useStateSubscriber", () => ({
	useIsSpinnerActive: vi.fn(() => ({
		isActive: false,
		startTime: null,
	})),
}))

// Mock StateManager
vi.mock("@/core/storage/StateManager", () => ({
	StateManager: {
		get: vi.fn(() => ({
			subscribe: vi.fn(() => () => {}),
			getGlobalSettingsKey: vi.fn((key: string) => {
				if (key === "mode") return "act"
				if (key === "yoloModeToggled") return false
				if (key === "actModeApiModelId") return "claude-sonnet-4-20250514"
				return null
			}),
			setGlobalState: vi.fn(),
		})),
	},
}))

// Mock child components that aren't under test
vi.mock("./ActionButtons", () => ({
	ActionButtons: () => React.createElement(Text, null, "ActionButtons"),
	getButtonConfig: vi.fn(() => ({ enableButtons: false })),
}))

vi.mock("./AsciiMotionCli", () => ({
	AsciiMotionCli: () => React.createElement(Text, null, "AsciiMotion"),
	StaticRobotFrame: () => React.createElement(Text, null, "StaticRobot"),
}))

vi.mock("./ChatMessage", () => ({
	ChatMessage: ({ message }: { message?: { ts?: number } }) => React.createElement(Text, null, `Message: ${message?.ts}`),
}))

vi.mock("./FileMentionMenu", () => ({
	FileMentionMenu: () => React.createElement(Text, null, "FileMentionMenu"),
}))

vi.mock("./HighlightedInput", () => ({
	HighlightedInput: ({ text }: { text?: string }) => React.createElement(Text, null, `Input: ${text}`),
}))

vi.mock("./HistoryPanelContent", () => ({
	HistoryPanelContent: () => React.createElement(Text, null, "HistoryPanel"),
}))

vi.mock("./SettingsPanelContent", () => ({
	SettingsPanelContent: () => React.createElement(Text, null, "SettingsPanel"),
}))

vi.mock("./SlashCommandMenu", () => ({
	SlashCommandMenu: () => React.createElement(Text, null, "SlashMenu"),
}))

vi.mock("./ThinkingIndicator", () => ({
	ThinkingIndicator: () => React.createElement(Text, null, "ThinkingIndicator"),
}))

// Mock utility functions
vi.mock("../utils/file-search", () => ({
	checkAndWarnRipgrepMissing: vi.fn(() => false),
	extractMentionQuery: vi.fn(() => ({ inMentionMode: false, query: "", atIndex: -1 })),
	getRipgrepInstallInstructions: vi.fn(() => "brew install ripgrep"),
	insertMention: vi.fn((text: string) => text),
	searchWorkspaceFiles: vi.fn(async () => []),
}))

vi.mock("../utils/slash-commands", () => ({
	executeStandaloneLocalSlashCommand: vi.fn(() => false),
	extractSlashQuery: vi.fn(() => ({ inSlashMode: false, query: "", slashIndex: -1 })),
	filterCommands: vi.fn(() => []),
	insertSlashCommand: vi.fn((text: string) => text),
	sortCommandsWorkflowsFirst: vi.fn((cmds: unknown[]) => cmds),
	mergeCliSlashCommands: vi.fn((commands: unknown[]) => commands),
}))

vi.mock("../utils/input", () => ({
	isMouseEscapeSequence: vi.fn(() => false),
	isTerminalResponseSequence: vi.fn(() => false),
}))

vi.mock("../utils/parser", () => ({
	jsonParseSafe: vi.fn((_text: string, defaultValue: unknown) => defaultValue),
	parseImagesFromInput: vi.fn((text: string) => ({ prompt: text, imagePaths: [] })),
	processImagePaths: vi.fn(async (images: string[]) => images),
}))

vi.mock("../utils/display", () => ({
	centerText: vi.fn((text: string) => text),
	createContextBar: vi.fn(() => ({ filled: "", empty: "" })),
	setTerminalTitle: vi.fn(),
}))

vi.mock("../utils/cursor", () => ({
	moveCursorUp: vi.fn((_text: string, pos: number) => pos),
	moveCursorDown: vi.fn((_text: string, pos: number) => pos),
}))

vi.mock("@/core/controller/slash/getAvailableSlashCommands", () => ({
	getAvailableSlashCommands: vi.fn(async () => ({ commands: [] })),
}))

vi.mock("@/core/controller/task/showTaskWithId", () => ({
	showTaskWithId: vi.fn(async () => {}),
}))

vi.mock("@shared/getApiMetrics", () => ({
	getApiMetrics: vi.fn(() => ({
		totalTokensIn: 0,
		totalTokensOut: 0,
		totalCost: 0,
		cacheHitRate: 0,
	})),
	getLastApiReqTotalTokens: vi.fn(() => 0),
}))

vi.mock("child_process", () => ({
	exec: vi.fn(),
	execFile: vi.fn(),
	execSync: vi.fn(() => "main"),
}))

// Mock telemetry service to prevent HostProvider errors in shutdown handler
vi.mock("@/services/telemetry", () => ({
	telemetryService: {
		captureHostEvent: vi.fn(),
	},
}))

// Helper to create a typed mock for onExit
const createExitMock = (): ExitMockFn => vi.fn() as ExitMockFn

describe("ChatView Exit and Cleanup", () => {
	let mockOnExit: ExitMockFn

	beforeEach(() => {
		vi.clearAllMocks()
		shutdownMockState.reset()
		mockOnExit = createExitMock()
	})

	afterEach(() => {
		vi.restoreAllMocks()
	})

	describe("Initial render state", () => {
		it("should render with input field, footer, and mode toggle visible", () => {
			const { lastFrame } = render(<ChatView onExit={mockOnExit} />)
			const frame = lastFrame() || ""

			// Input field visible
			expect(frame).toContain("Input:")
			// Footer with help text
			expect(frame).toContain("@ files")
			expect(frame).toContain("/ commands")
			// Mode toggle
			expect(frame).toContain("Plan")
			expect(frame).toContain("Act")
			const logoIndex = frame.indexOf("AsciiMotion")
			const quoteIndex = frame.indexOf(`“${QUOTES[0]}”`)
			const questionIndex = frame.indexOf(`Questions about Dirac? Query the code (v${CLI_VERSION})`)
			expect(quoteIndex).toBeGreaterThan(logoIndex)
			expect(questionIndex).toBeGreaterThan(quoteIndex)
		})
	})

	describe("Shutdown event handling", () => {
		it("should subscribe on mount and unsubscribe on unmount", () => {
			const { unmount } = render(<ChatView onExit={mockOnExit} />)
			expect(shutdownMockState.listeners.length).toBe(1)

			unmount()
			expect(shutdownMockState.listeners.length).toBe(0)
		})

		it("should hide input when shutdown event fires", async () => {
			const { lastFrame } = render(<ChatView onExit={mockOnExit} />)

			// Input should be visible initially
			expect(lastFrame()).toContain("Input:")

			// Fire shutdown event (simulates Ctrl+C)
			shutdownMockState.fire()
			await delay()

			// Input should be hidden after shutdown
			expect(lastFrame()).not.toContain("Input:")
		})

		it("should preserve footer when shutdown event fires", async () => {
			const { lastFrame } = render(<ChatView onExit={mockOnExit} />)

			// Footer should be visible initially
			expect(lastFrame()).toContain("@ files")

			// Fire shutdown event
			shutdownMockState.fire()
			await delay()

			// Footer should still be present (only input is hidden)
			expect(lastFrame()).toContain("@ files")
		})
	})

	describe("Edge cases", () => {
		it("should handle shutdown event when onExit prop is undefined", async () => {
			const { lastFrame } = render(<ChatView />)

			// Fire shutdown event
			shutdownMockState.fire()
			await delay()

			// Should not throw, UI should still hide
			expect(lastFrame()).not.toContain("Input:")
		})

		it("should handle multiple shutdown events gracefully", async () => {
			const { lastFrame } = render(<ChatView onExit={mockOnExit} />)

			// Fire multiple shutdown events
			shutdownMockState.fire()
			shutdownMockState.fire()
			shutdownMockState.fire()

			await delay()

			// UI should still hide properly
			expect(lastFrame()).not.toContain("Input:")
		})
	})
})

describe("ChatView UI State During Exit", () => {
	beforeEach(() => {
		vi.clearAllMocks()
		shutdownMockState.reset()
	})

	it("should preserve static content and footer, only hide input during exit", async () => {
		const onExit = createExitMock()
		const { lastFrame } = render(<ChatView onExit={onExit} />)

		// Footer contains auto-approve toggle
		expect(lastFrame()).toContain("Auto-approve")
		expect(lastFrame()).toContain(`Questions about Dirac? Query the code (v${CLI_VERSION}) directly using /askDirac`)
		expect(lastFrame()).toContain("Input:")

		// Fire shutdown event
		shutdownMockState.fire()
		await delay()

		const frameAfter = lastFrame()

		// Static content should still be present
		expect(frameAfter).toContain(`Questions about Dirac? Query the code (v${CLI_VERSION}) directly using /askDirac`)
		// Footer should still be present (only input is hidden)
		expect(frameAfter).toContain("Auto-approve")
		// Input should be hidden
		expect(frameAfter).not.toContain("Input:")
	})
})
describe("ChatView conversation follow-ups", () => {
	beforeEach(() => {
		vi.clearAllMocks()
		shutdownMockState.reset()
	})

	it.each([
		TaskStatus.COMPLETED,
		TaskStatus.CANCELLED,
		TaskStatus.IDLE,
	])("submits input to the existing %s conversation rather than starting a new task", async (taskStatus) => {
		const task = {
			taskId: "original-task",
			canAcceptSteeringMessage: () => false,
			submitCardResponse: vi.fn(async () => undefined),
		}
		const controller = {
			task,
			getPromptHistory: vi.fn(async () => []),
			initTask: vi.fn(),
			prepareTaskForFollowUp: vi.fn(async () => task),
		}
		vi.mocked(useTaskState).mockReturnValue({ diracMessages: [], mode: "act", taskStatus } as any)
		vi.mocked(useTaskContext).mockReturnValue({ controller, setLastError: vi.fn() } as any)
		const { unmount } = render(<ChatView controller={controller} />)
		await latestChatInputProps.handleSubmit("follow up using prior context", [])
		expect(controller.prepareTaskForFollowUp).toHaveBeenCalledOnce()
		expect(task.submitCardResponse).toHaveBeenCalledWith(
			"",
			DiracAskResponse.MESSAGE,
			"follow up using prior context",
			undefined,
		)
		expect(controller.initTask).not.toHaveBeenCalled()
		unmount()
	})

	it("submits a reopened completed chat to the restored backing task", async () => {
		const oldTask = { taskId: "saved-task", canAcceptSteeringMessage: () => false, submitCardResponse: vi.fn() }
		const restored = { taskId: "saved-task", submitCardResponse: vi.fn(async () => undefined) }
		const controller = {
			task: oldTask,
			getPromptHistory: vi.fn(async () => []),
			initTask: vi.fn(),
			prepareTaskForFollowUp: vi.fn(async () => restored),
		}
		vi.mocked(useTaskState).mockReturnValue({ diracMessages: [], mode: "act", taskStatus: TaskStatus.COMPLETED } as any)
		vi.mocked(useTaskContext).mockReturnValue({ controller, setLastError: vi.fn() } as any)
		const { unmount } = render(<ChatView controller={controller} />)
		await latestChatInputProps.handleSubmit("continue tomorrow", ["image.png"])
		expect(restored.submitCardResponse).toHaveBeenCalledWith("", DiracAskResponse.MESSAGE, "continue tomorrow", ["image.png"])
		expect(oldTask.submitCardResponse).not.toHaveBeenCalled()
		expect(controller.initTask).not.toHaveBeenCalled()
		unmount()
	})

	it("starts a task only when there is no active conversation", async () => {
		const controller = { getPromptHistory: vi.fn(async () => []), initTask: vi.fn(async () => undefined) }
		vi.mocked(useTaskState).mockReturnValue({ diracMessages: [], mode: "act", taskStatus: TaskStatus.IDLE } as any)
		vi.mocked(useTaskContext).mockReturnValue({ controller, setLastError: vi.fn() } as any)
		const { unmount } = render(<ChatView controller={controller} />)
		await latestChatInputProps.handleSubmit("new conversation", [])
		expect(controller.initTask).toHaveBeenCalledWith("new conversation", undefined)
		unmount()
	})
})

describe("ChatView active input", () => {
	beforeEach(() => {
		vi.clearAllMocks()
		shutdownMockState.reset()
		forceRuntimeProcessing = false
		vi.mocked(useIsSpinnerActive).mockReturnValue({ isActive: false, startTime: undefined })
	})

	function activeChat(overrides: Record<string, unknown> = {}) {
		const task = {
			taskId: "sleeping-root",
			canAcceptSteeringMessage: vi.fn(() => true),
			submitCardResponse: vi.fn(async (): Promise<void> => undefined),
		}
		const controller = {
			task,
			getPromptHistory: vi.fn(async () => []),
			prepareTaskForFollowUp: vi.fn(),
			initTask: vi.fn(),
			sendGoalMessage: vi.fn(async () => undefined),
		}
		const setLastError = vi.fn()
		vi.mocked(useTaskState).mockReturnValue({
			diracMessages: [],
			mode: "act",
			taskStatus: TaskStatus.EXECUTING_TOOL,
			...overrides,
		} as any)
		vi.mocked(useTaskContext).mockReturnValue({ controller, setLastError } as any)
		return { task, controller, setLastError }
	}

	it("routes Enter through the input handler while the ordinary root is sleeping and processing", async () => {
		forceRuntimeProcessing = true
		vi.mocked(useIsSpinnerActive).mockReturnValue({ isActive: true, startTime: undefined })
		const { task, controller } = activeChat()
		const app = render(<ChatView controller={controller} />)
		latestChatInputProps.setTextInput("wake up with this user text")
		latestChatInputProps.setCursorPos(27)
		await delay()
		capturedInput.handler!("\r", { return: true } as import("ink").Key)
		await delay()
		expect(task.submitCardResponse).toHaveBeenCalledWith(
			"",
			DiracAskResponse.MESSAGE,
			"wake up with this user text",
			undefined,
		)
		expect(controller.prepareTaskForFollowUp).not.toHaveBeenCalled()
		expect(controller.initTask).not.toHaveBeenCalled()
		app.unmount()
	})

	it("expands pasted input and forwards images on the active root", async () => {
		const { task, controller } = activeChat()
		const app = render(<ChatView controller={controller} />)
		latestChatInputProps.setPastedTexts(new Map([[1, "actual pasted guidance"]]))
		await delay()
		await latestChatInputProps.handleSubmit("[Pasted text #1 +2 lines]", ["image.png"])
		expect(task.submitCardResponse).toHaveBeenCalledWith("", DiracAskResponse.MESSAGE, "actual pasted guidance", [
			"image.png",
		])
		expect(controller.prepareTaskForFollowUp).not.toHaveBeenCalled()
		app.unmount()
	})

	it("blocks duplicate in-flight input and accepts another message after settlement", async () => {
		const { task, controller } = activeChat()
		let release!: () => void
		task.submitCardResponse.mockImplementationOnce(
			() =>
				new Promise<void>((resolve) => {
					release = resolve
				}),
		)
		const app = render(<ChatView controller={controller} />)
		const first = latestChatInputProps.handleSubmit("first", [])
		await delay()
		await latestChatInputProps.handleSubmit("duplicate", [])
		expect(task.submitCardResponse).toHaveBeenCalledTimes(1)
		release()
		await first
		await latestChatInputProps.handleSubmit("second", [])
		expect(task.submitCardResponse).toHaveBeenCalledTimes(2)
		app.unmount()
	})

	it("releases the submission latch after failure without clearing input", async () => {
		const { task, controller, setLastError } = activeChat()
		task.submitCardResponse.mockRejectedValueOnce(new Error("queue failed"))
		const app = render(<ChatView controller={controller} />)
		latestChatInputProps.setTextInput("keep my input")
		await delay()
		await latestChatInputProps.handleSubmit("keep my input", [])
		expect(latestChatInputProps.textInputRef.current).toBe("keep my input")
		expect(setLastError).toHaveBeenLastCalledWith(expect.stringContaining("queue failed"))
		await latestChatInputProps.handleSubmit("retry", [])
		expect(task.submitCardResponse).toHaveBeenCalledTimes(2)
		app.unmount()
	})

	it("does not bypass runtime guards when the task cannot accept steering", async () => {
		forceRuntimeProcessing = true
		const { task, controller } = activeChat()
		task.canAcceptSteeringMessage.mockReturnValue(false)
		const app = render(<ChatView controller={controller} />)
		await latestChatInputProps.handleSubmit("not accepted", [])
		expect(task.submitCardResponse).not.toHaveBeenCalled()
		expect(controller.prepareTaskForFollowUp).not.toHaveBeenCalled()
		app.unmount()
	})

	it.each([false, true])("preserves Goal message routing (interaction passthrough: %s)", async (passthrough) => {
		const card = {
			id: "goal-interaction",
			ts: 1,
			content: {
				type: DiracMessageType.CARD,
				card: {
					status: "pending",
					toolName: "resolve_task_interaction",
					content: "question",
					requireFeedback: true,
				},
			},
		}
		const { task, controller } = activeChat({
			goal: { id: "goal", status: "waiting" },
			diracMessages: passthrough ? [card] : [],
			uiActionState: { activeCardId: passthrough ? card.id : undefined, globalButtons: [], cardButtons: [] },
		})
		const app = render(<ChatView controller={controller} />)
		await latestChatInputProps.handleSubmit("goal guidance", [])
		expect(controller.sendGoalMessage).toHaveBeenCalledWith("goal", "goal guidance")
		expect(task.submitCardResponse).not.toHaveBeenCalled()
		app.unmount()
	})

	it("preserves pending approval responses instead of submitting empty-card steering", async () => {
		const card = {
			id: "approval",
			ts: 1,
			content: {
				type: DiracMessageType.CARD,
				card: {
					status: "pending",
					toolName: "execute_command",
					content: "command",
					requireApproval: true,
				},
			},
		}
		const { task, controller } = activeChat({
			diracMessages: [card],
			uiActionState: { activeCardId: card.id, globalButtons: [], cardButtons: [] },
		})
		const app = render(<ChatView controller={controller} />)
		await latestChatInputProps.handleSubmit("yes", [])
		expect(task.submitCardResponse).toHaveBeenCalledWith(
			card.id,
			DiracAskResponse.APPROVE,
			undefined,
			undefined,
			undefined,
			undefined,
		)
		expect(controller.prepareTaskForFollowUp).not.toHaveBeenCalled()
		app.unmount()
	})
})
