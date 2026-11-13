import { CardStatus, type DiracMessage, DiracMessageType } from "@shared/ExtensionMessage"
import { render } from "@testing-library/react"
import { createRef, type ComponentProps } from "react"
import { describe, expect, it, vi } from "vitest"
import type { ChatState } from "../types/chatTypes"
import ActionButtons from "./ActionButtons"

vi.mock("@vscode/webview-ui-toolkit/react", () => ({
	VSCodeButton: ({ children }: { children: React.ReactNode }) => <button>{children}</button>,
}))

const task: DiracMessage = {
	id: "task",
	ts: 1,
	content: { type: DiracMessageType.MARKDOWN, role: "user", content: "Run a command" },
}
const terminal: DiracMessage = {
	id: "command",
	ts: 2,
	content: {
		type: DiracMessageType.CARD,
		card: { id: "command", header: "echo one", icon: "terminal", status: CardStatus.SUCCESS, renderType: "text" },
	},
}
const apiStatus: DiracMessage = {
	id: "api-request",
	ts: 3,
	content: { type: DiracMessageType.API_STATUS, status: {} },
}

function createProps(): ComponentProps<typeof ActionButtons> & { chatState: ChatState } {
	return {
		task,
		chatState: {
			inputValue: "Unsent guidance",
			setInputValue: vi.fn(),
			activeQuote: null,
			setActiveQuote: vi.fn(),
			isTextAreaFocused: true,
			setIsTextAreaFocused: vi.fn(),
			selectedImages: ["data:image/png;base64,draft"],
			setSelectedImages: vi.fn(),
			selectedFiles: ["draft.ts"],
			setSelectedFiles: vi.fn(),
			sendingDisabled: false,
			setSendingDisabled: vi.fn(),
			expandedRows: {},
			setExpandedRows: vi.fn(),
			textAreaRef: createRef<HTMLTextAreaElement>(),
			lastMessage: apiStatus,
			secondLastMessage: terminal,
			task,
			handleFocusChange: vi.fn(),
			clearExpandedRows: vi.fn(),
			resetState: vi.fn(),
			isApiRequestActive: true,
		},
		messageHandlers: {
			executeButtonAction: vi.fn().mockResolvedValue(undefined),
			handleSendMessage: vi.fn().mockResolvedValue(undefined),
			handleTaskCloseButtonClick: vi.fn(),
			startNewTask: vi.fn().mockResolvedValue(undefined),
		},
		scrollBehavior: {
			scrollToBottomSmooth: vi.fn(),
			scrollToTop: vi.fn(),
			showScrollToBottom: true,
		},
	}
}

function expectDraftUntouched(chatState: ChatState) {
	expect(chatState.setInputValue).not.toHaveBeenCalled()
	expect(chatState.setSelectedImages).not.toHaveBeenCalled()
	expect(chatState.setSelectedFiles).not.toHaveBeenCalled()
}

describe("ActionButtons draft preservation", () => {
	it("keeps ordinary messaging available while host approval waiters are pending", () => {
		const props = createProps()
		props.chatState.uiActionState = { pendingApprovalCardIds: ["approval-a", "approval-b"], globalButtons: [], cardButtons: [], sendingDisabled: true }
		const { rerender } = render(<ActionButtons {...props} />)
		expect(props.chatState.setSendingDisabled).toHaveBeenLastCalledWith(false)
		expectDraftUntouched(props.chatState)
		rerender(<ActionButtons {...props} chatState={{ ...props.chatState, uiActionState: { ...props.chatState.uiActionState, pendingApprovalCardIds: [], globalButtons: [], cardButtons: [], sendingDisabled: true } }} />)
		expect(props.chatState.setSendingDisabled).toHaveBeenLastCalledWith(true)
	})

	it("preserves an unsent draft and attachments when a command is followed by an API request", () => {
		const props = createProps()
		const { rerender } = render(
			<ActionButtons {...props} chatState={{ ...props.chatState, lastMessage: terminal, secondLastMessage: task }} />,
		)
		expectDraftUntouched(props.chatState)

		rerender(<ActionButtons {...props} />)
		expectDraftUntouched(props.chatState)
	})

	it("does not reset input on each keystroke while the API status follows a terminal card", () => {
		const props = createProps()
		const { rerender } = render(<ActionButtons {...props} />)
		expectDraftUntouched(props.chatState)

		// useChatState returns a fresh object for each input-driven render.
		for (const inputValue of ["h", "he", "hel", "hell", "hello"]) {
			rerender(<ActionButtons {...props} chatState={{ ...props.chatState, inputValue }} />)
			expectDraftUntouched(props.chatState)
		}
	})
})
