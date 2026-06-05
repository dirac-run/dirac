import { render } from "ink-testing-library"
// biome-ignore lint/correctness/noUnusedImports: React must be in scope for JSX in this test file.
import React from "react"
import { beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("ink-picture", () => ({
	TerminalInfoProvider: ({ children }: any) => children,
}))

// Mock ink's useApp
const mockExit = vi.fn()
vi.mock("ink", async (importOriginal) => {
	const actual = await importOriginal<typeof import("ink")>()
	return {
		...actual,
		useApp: () => ({ exit: mockExit }),
	}
})

// Mock child_process
vi.mock("child_process", () => ({
	execSync: vi.fn().mockReturnValue(""),
	exec: vi.fn(),
}))

// Mock dependencies
vi.mock("@/core/controller/slash/getAvailableSlashCommands", () => ({
	getAvailableSlashCommands: vi.fn().mockResolvedValue({ commands: [] }),
}))

vi.mock("@/core/storage/StateManager", () => ({
	StateManager: {
		get: () => ({
			getGlobalSettingsKey: vi.fn().mockReturnValue("act"),
			getGlobalStateKey: vi.fn().mockReturnValue([]),
			getApiConfiguration: vi.fn().mockReturnValue({}),
		}),
	},
}))

vi.mock("@/services/telemetry", () => ({
	telemetryService: {
		captureHostEvent: vi.fn(),
	},
}))

vi.mock("@shared/services/Session", () => ({
	Session: {
		get: () => ({
			getStats: vi.fn().mockReturnValue({}),
		}),
	},
}))

vi.mock("../context/TaskContext", () => ({
	useTaskContext: () => ({
		controller: {},
		clearState: vi.fn(),
	}),
	useTaskState: () => ({
		diracMessages: [],
	}),
}))

vi.mock("../hooks/useStateSubscriber", () => ({
	useIsSpinnerActive: () => ({ isActive: false, startTime: 0 }),
}))

vi.mock("../utils/display", () => ({
	centerText: vi.fn((text: string) => text),
	createContextBar: vi.fn(() => ({ filled: "", empty: "" })),
	setTerminalTitle: vi.fn(),
}))

// Capture the latest props passed to useChatInputHandler so we can:
// 1. Set the text input directly (bypassing the ink StdinContext mismatch between
//    ink-testing-library v6 and the source's ink v7)
// 2. Inspect filteredCommands after re-render to simulate slash menu selection
type ChatInputProps = Parameters<typeof import("../hooks/useChatInputHandler").useChatInputHandler>[0]
let latestChatInputProps: ChatInputProps | null = null

vi.mock("../hooks/useChatInputHandler", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../hooks/useChatInputHandler")>()
	return {
		useChatInputHandler: (props: ChatInputProps) => {
			latestChatInputProps = props
			return actual.useChatInputHandler(props)
		},
	}
})

import { ChatView } from "./ChatView"

// Helper to wait for async state updates and re-renders
const delay = (ms = 60) => new Promise((resolve) => setTimeout(resolve, ms))

// Simulate pressing Enter to confirm the top slash command in the menu.
// This mirrors the Enter-key path in useChatInputHandler for the slash menu.
function selectTopSlashCommand() {
	if (!latestChatInputProps) throw new Error("useChatInputHandler props not captured yet")
	const { filteredCommands, selectedSlashIndex, slashMenuDismissed, handleExit } = latestChatInputProps
	if (filteredCommands.length === 0 || slashMenuDismissed) {
		throw new Error(`Slash menu not active: commands=${filteredCommands.length} dismissed=${slashMenuDismissed}`)
	}
	const cmd = filteredCommands[selectedSlashIndex]
	if (!cmd) {
		throw new Error(`No command at selectedSlashIndex=${selectedSlashIndex}`)
	}
	if (cmd.name === "exit" || cmd.name === "q") {
		handleExit()
	}
}

describe("Quit Command (/q and /exit)", () => {
	const mockOnExit = vi.fn()

	beforeEach(() => {
		vi.clearAllMocks()
		latestChatInputProps = null
	})

	it("should exit the application when /q is selected from slash menu", async () => {
		render(<ChatView onExit={mockOnExit} />)
		await delay()

		// Set text input to "/q" — this updates the underlying text ref synchronously
		// and schedules a React re-render that recomputes filteredCommands.
		latestChatInputProps!.setTextInput("/q")
		await delay()

		// After re-render, filteredCommands should contain the /q command.
		// Simulate pressing Enter to confirm the slash menu selection.
		selectTopSlashCommand()

		// handleExit has a 150ms timeout before calling app.exit()
		await delay(200)

		expect(mockExit).toHaveBeenCalled()
		expect(mockOnExit).toHaveBeenCalled()
	})

	it("should exit the application when /exit is selected from slash menu", async () => {
		render(<ChatView onExit={mockOnExit} />)
		await delay()

		// Set text input to "/exit" to filter the slash menu to the /exit command.
		latestChatInputProps!.setTextInput("/exit")
		await delay()

		// Simulate pressing Enter to confirm the /exit slash menu selection.
		selectTopSlashCommand()

		// handleExit has a 150ms timeout before calling app.exit()
		await delay(200)

		expect(mockExit).toHaveBeenCalled()
		expect(mockOnExit).toHaveBeenCalled()
	})
})
