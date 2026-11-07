import type { Key } from "ink"
import { render } from "ink-testing-library"
// biome-ignore lint/correctness/noUnusedImports: Vitest transforms this test with the classic JSX runtime.
import React from "react"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { createInputViewport } from "../utils/input-viewport"
import { useChatInputHandler } from "./useChatInputHandler"

type ChatInputProps = Parameters<typeof useChatInputHandler>[0]
type InputHandler = (input: string, key: Key) => void

const capturedInput = vi.hoisted(() => ({ handler: null as InputHandler | null }))

vi.mock("ink", async (importOriginal) => {
	const actual = await importOriginal<typeof import("ink")>()
	return {
		...actual,
		useInput: (handler: InputHandler) => {
			capturedInput.handler = handler
		},
	}
})

function InputHarness(props: ChatInputProps) {
	useChatInputHandler(props)
	return null
}

const draft = "first\nsecond\nthird"

it.each(["upArrow", "downArrow"] as const)("routes Ctrl+%s to recall before Vim and completion menus", (direction) => {
	const props = createInputProps({
		textInputRef: { current: "/a" },
		cursorPosRef: { current: 2 },
		filteredCommands: [{ name: "agent" }],
		handleVimInput: vi.fn(() => true),
	})
	const app = render(<InputHarness {...props} />)
	pressKey({ ctrl: true, [direction]: true })
	expect(props.navigateHistory).toHaveBeenCalledWith(direction === "upArrow" ? "older" : "newer")
	expect(props.handleVimInput).not.toHaveBeenCalled()
	expect(props.setSelectedSlashIndex).not.toHaveBeenCalled()
	expect(props.setCardScrollOffset).not.toHaveBeenCalled()
	app.unmount()
})

it.each([
	{ command: "quiet", menu: true },
	{ command: "quiet", menu: false },
	{ command: "settings", menu: true },
	{ command: "settings", menu: false },
])("uses the complete composer reset for /$command (menu: $menu)", ({ command, menu }) => {
	const text = `/${command}`
	const props = createInputProps({
		textInputRef: { current: text },
		cursorPosRef: { current: text.length },
		filteredCommands: menu ? [{ name: command }] : [],
	})
	const app = render(<InputHarness {...props} />)
	pressKey({ return: true }, "\r")
	expect(props.resetInput).toHaveBeenCalledOnce()
	expect(props.setTextInput).not.toHaveBeenCalled()
	expect(props.setCursorPos).not.toHaveBeenCalled()
	expect(props.handleSubmit).not.toHaveBeenCalled()
	if (command === "quiet") expect(props.toggleQuietMode).toHaveBeenCalledOnce()
	else expect(props.setActivePanel).toHaveBeenCalledWith({ type: "settings" })
	app.unmount()
})

it.each([true, false])("keeps /agents local while running and waiting for approval (menu: %s)", (menu) => {
	const props = createInputProps({
		textInputRef: { current: "/agents" },
		cursorPosRef: { current: 7 },
		filteredCommands: menu ? [{ name: "agents" }] : [],
		isSpinnerActive: true,
		isProcessing: true,
		pendingAsk: { content: { type: "card", card: { requireApproval: true } } },
	})
	const app = render(<InputHarness {...props} />)
	pressKey({ return: true }, "\r")
	expect(props.showAgentSnapshot).toHaveBeenCalledOnce()
	expect(props.handleSubmit).not.toHaveBeenCalled()
	expect(props.handleButtonAction).not.toHaveBeenCalled()
	expect(props.resetInput).toHaveBeenCalledOnce()
	app.unmount()
})

it("does not execute the observation menu command inside a prompt or attachment draft", () => {
	const props = createInputProps({
		textInputRef: { current: '"image.png" /agents' },
		cursorPosRef: { current: 19 },
		filteredCommands: [{ name: "agents" }],
	})
	const app = render(<InputHarness {...props} />)
	pressKey({ return: true }, "\r")
	expect(props.showAgentSnapshot).not.toHaveBeenCalled()
	expect(props.resetInput).not.toHaveBeenCalled()
	app.unmount()
})

function createInputProps(overrides: Partial<ChatInputProps> = {}): ChatInputProps {
	const textInputRef = overrides.textInputRef ?? { current: draft }
	const cursorPosRef = overrides.cursorPosRef ?? { current: 8 }
	return {
		workspacePath: "/workspace",
		inputColumns: 80,
		textInputRef,
		cursorPosRef,
		setTextInput: vi.fn(),
		setCursorPos: vi.fn((pos) => {
			cursorPosRef.current = typeof pos === "function" ? pos(cursorPosRef.current) : pos
		}),
		activePanel: null,
		setActivePanel: vi.fn(),
		handleAskShortcuts: vi.fn(() => false),
		handleKeyboardSequence: vi.fn(() => false),
		handleCtrlShortcut: vi.fn(() => false),
		resetInput: vi.fn(),
		insertTextAtCursor: vi.fn(),
		toggleMode: vi.fn(),
		toggleAutoApproveAll: vi.fn(),
		enableFastMode: vi.fn(),
		toggleQuietMode: vi.fn(),
		showAgentSnapshot: vi.fn(),
		handleSubmit: vi.fn(),
		handleExit: vi.fn(),
		clearViewAndResetTask: vi.fn(),
		filteredCommands: [],
		selectedSlashIndex: 0,
		setSelectedSlashIndex: vi.fn(),
		slashMenuDismissed: false,
		setSlashMenuDismissed: vi.fn(),
		fileResults: [],
		selectedIndex: 0,
		setSelectedIndex: vi.fn(),
		setFileResults: vi.fn(),
		getHistoryItems: vi.fn(() => []),
		navigateHistory: vi.fn(),
		historyIndex: -1,
		setHistoryIndex: vi.fn(),
		savedInput: "",
		setSavedInput: vi.fn(),
		isSpinnerActive: false,
		isProcessing: false,
		yolo: false,
		uiActionState: {},
		pendingAsk: null,
		handleButtonAction: vi.fn(),
		isYoloSuppressed: vi.fn(() => false),
		lastPasteTimeRef: { current: 0 },
		activePasteNumRef: { current: 0 },
		activePasteLinesRef: { current: 0 },
		activePasteStartPosRef: { current: 0 },
		pasteCounterRef: { current: 0 },
		pasteUpdateTimeoutRef: { current: null },
		setPastedTexts: vi.fn(),
		PASTE_COLLAPSE_THRESHOLD: 10000,
		PASTE_CHUNK_WINDOW_MS: 150,
		PASTE_UPDATE_DEBOUNCE_MS: 50,
		mode: "act",
		isEmptyConversation: false,
		scrollableCardMaxOffset: 10,
		cardScrollOffset: 4,
		setCardScrollOffset: vi.fn(),
		handleGoalControl: vi.fn(),
		toggleGoalDetails: vi.fn(),
		disarmGoalStopConfirmation: vi.fn(),
		...overrides,
	}
}

function pressKey(keyOverrides: Partial<Key>, input = "") {
	if (!capturedInput.handler) throw new Error("useInput handler was not registered")
	capturedInput.handler(input, {
		upArrow: false,
		downArrow: false,
		leftArrow: false,
		rightArrow: false,
		pageDown: false,
		pageUp: false,
		return: false,
		escape: false,
		ctrl: false,
		shift: false,
		tab: false,
		backspace: false,
		delete: false,
		meta: false,
		...keyOverrides,
	})
}

describe("useChatInputHandler arrow navigation", () => {
	beforeEach(() => {
		capturedInput.handler = null
	})

	it.each([0, 4, 10])("moves within the draft before scrolling a response at offset %i", (cardScrollOffset) => {
		const props = createInputProps({ cardScrollOffset })
		const app = render(<InputHarness {...props} />)

		pressKey({ upArrow: true })
		expect(props.setCursorPos).toHaveBeenLastCalledWith(2)
		pressKey({ downArrow: true })
		expect(props.setCursorPos).toHaveBeenLastCalledWith(8)
		pressKey({ downArrow: true })
		expect(props.setCursorPos).toHaveBeenLastCalledWith(15)
		expect(props.setCardScrollOffset).not.toHaveBeenCalled()
		app.unmount()
	})

	it("keeps a long draft viewport following the cursor without scrolling the response", () => {
		const text = Array.from({ length: 20 }, (_, index) => `line ${index}`).join("\n")
		const props = createInputProps({ textInputRef: { current: text }, cursorPosRef: { current: text.length } })
		const app = render(<InputHarness {...props} />)
		expect(createInputViewport(text, props.cursorPosRef.current, 40, 3).hasHiddenBefore).toBe(true)

		for (let index = 0; index < 19; index++) pressKey({ upArrow: true })

		const viewport = createInputViewport(text, props.cursorPosRef.current, 40, 3)
		expect(viewport.text).toContain("line 0\n")
		expect(viewport.hasHiddenBefore).toBe(false)
		expect(props.setCardScrollOffset).not.toHaveBeenCalled()
		app.unmount()
	})

	it.each([0, 4, 10])("moves through soft-wrapped input before scrolling at offset %i", (cardScrollOffset) => {
		const text = "abcdefghijklmnop"
		const props = createInputProps({
			textInputRef: { current: text },
			cursorPosRef: { current: text.length },
			inputColumns: 5,
			cardScrollOffset,
		})
		const app = render(<InputHarness {...props} />)
		pressKey({ upArrow: true })
		expect(props.setCursorPos).toHaveBeenLastCalledWith(11)
		pressKey({ upArrow: true })
		expect(props.setCursorPos).toHaveBeenLastCalledWith(7)
		pressKey({ downArrow: true })
		expect(props.setCursorPos).toHaveBeenLastCalledWith(11)
		expect(props.setCardScrollOffset).not.toHaveBeenCalled()
		app.unmount()
	})

	it.each([
		{ cursorPos: 2, key: { upArrow: true }, expected: 0 },
		{ cursorPos: draft.length - 2, key: { downArrow: true }, expected: draft.length },
	])("moves to the input edge before scrolling ($cursorPos)", ({ cursorPos, key, expected }) => {
		const props = createInputProps({ cursorPosRef: { current: cursorPos } })
		const app = render(<InputHarness {...props} />)
		pressKey(key)
		expect(props.setCursorPos).toHaveBeenCalledWith(expected)
		expect(props.setCardScrollOffset).not.toHaveBeenCalled()
		app.unmount()
	})

	it.each([
		{ text: draft, cursorPos: 0, key: { upArrow: true }, expected: 5 },
		{ text: draft, cursorPos: draft.length, key: { downArrow: true }, expected: 3 },
		{ text: "", cursorPos: 0, key: { upArrow: true }, expected: 5 },
		{ text: "", cursorPos: 0, key: { downArrow: true }, expected: 3 },
	])("scrolls the response only when the cursor cannot move ($expected)", ({ text, cursorPos, key, expected }) => {
		const props = createInputProps({ textInputRef: { current: text }, cursorPosRef: { current: cursorPos } })
		const app = render(<InputHarness {...props} />)
		pressKey(key)
		expect(props.setCardScrollOffset).toHaveBeenCalledWith(expected)
		expect(props.setCursorPos).not.toHaveBeenCalled()
		app.unmount()
	})

	it.each([
		{ cardScrollOffset: 10, scrollableCardMaxOffset: 10, key: { upArrow: true } },
		{ cardScrollOffset: 0, scrollableCardMaxOffset: 10, key: { downArrow: true } },
		{ cardScrollOffset: 0, scrollableCardMaxOffset: 0, key: { upArrow: true } },
		{ cardScrollOffset: 0, scrollableCardMaxOffset: 0, key: { downArrow: true } },
	])("does not scroll beyond response limits (%j)", ({ cardScrollOffset, scrollableCardMaxOffset, key }) => {
		const props = createInputProps({
			textInputRef: { current: "" },
			cursorPosRef: { current: 0 },
			cardScrollOffset,
			scrollableCardMaxOffset,
		})
		const app = render(<InputHarness {...props} />)
		pressKey(key)
		expect(props.setCardScrollOffset).not.toHaveBeenCalled()
		expect(props.setCursorPos).not.toHaveBeenCalled()
		app.unmount()
	})

	it.each(["upArrow", "downArrow"] as const)("preserves slash and mention menu priority for %s", (direction) => {
		for (const menu of ["slash", "mention"]) {
			const text = menu === "slash" ? "/a" : "@a"
			const props = createInputProps({
				textInputRef: { current: text },
				cursorPosRef: { current: text.length },
				filteredCommands: menu === "slash" ? [{ name: "agent" }] : [],
				fileResults: menu === "mention" ? [{ path: "a.ts" }] : [],
			})
			const app = render(<InputHarness {...props} />)
			pressKey({ [direction]: true })
			expect(menu === "slash" ? props.setSelectedSlashIndex : props.setSelectedIndex).toHaveBeenCalledOnce()
			expect(props.setCursorPos).not.toHaveBeenCalled()
			expect(props.setCardScrollOffset).not.toHaveBeenCalled()
			app.unmount()
		}
	})

	it.each([
		{ input: "", key: { return: true, shift: true } },
		{ input: "[13;2u", key: {} },
		{ input: "[27;2;13~", key: {} },
	])("inserts a newline for Shift+Enter before slash or mention selection ($input)", ({ input, key }) => {
		for (const menu of ["none", "slash", "mention"]) {
			const text = menu === "slash" ? "/a" : menu === "mention" ? "@a" : draft
			const props = createInputProps({
				textInputRef: { current: text },
				cursorPosRef: { current: text.length },
				filteredCommands: menu === "slash" ? [{ name: "agent" }] : [],
				fileResults: menu === "mention" ? [{ path: "a.ts" }] : [],
			})
			const app = render(<InputHarness {...props} />)
			pressKey(key, input)
			expect(props.insertTextAtCursor).toHaveBeenCalledExactlyOnceWith("\n")
			expect(props.handleSubmit).not.toHaveBeenCalled()
			expect(props.handleAskShortcuts).not.toHaveBeenCalled()
			expect(props.setTextInput).not.toHaveBeenCalled()
			expect(props.setSelectedSlashIndex).not.toHaveBeenCalled()
			expect(props.setSelectedIndex).not.toHaveBeenCalled()
			app.unmount()
		}
	})

	it.each(["[13;2u", "[27;2;13~"])("does not edit the draft behind an active panel (%s)", (input) => {
		const props = createInputProps({ activePanel: { type: "help" } })
		const app = render(<InputHarness {...props} />)
		pressKey({}, input)
		expect(props.insertTextAtCursor).not.toHaveBeenCalled()
		expect(props.handleSubmit).not.toHaveBeenCalled()
		app.unmount()
	})

	it("still ignores unrelated terminal replies", () => {
		const props = createInputProps()
		const app = render(<InputHarness {...props} />)
		pressKey({}, "[4;991;1710t")
		expect(props.insertTextAtCursor).not.toHaveBeenCalled()
		expect(props.handleSubmit).not.toHaveBeenCalled()
		app.unmount()
	})

	it("preserves Shift+Down newline insertion", () => {
		const props = createInputProps()
		const app = render(<InputHarness {...props} />)
		pressKey({ shift: true, downArrow: true })
		expect(props.insertTextAtCursor).toHaveBeenCalledWith("\n")
		expect(props.setCursorPos).not.toHaveBeenCalled()
		expect(props.setCardScrollOffset).not.toHaveBeenCalled()
		app.unmount()
	})

	it.each(["upArrow", "downArrow"] as const)("preserves prompt history priority for %s", (direction) => {
		const props = createInputProps({
			isEmptyConversation: true,
			textInputRef: { current: draft },
			cursorPosRef: { current: 8 },
			getHistoryItems: () => [draft, "older prompt"],
			historyIndex: 0,
		})
		const app = render(<InputHarness {...props} />)
		pressKey({ [direction]: true })
		expect(props.setHistoryIndex).toHaveBeenCalledWith(direction === "upArrow" ? 1 : -1)
		expect(props.setTextInput).toHaveBeenCalledWith(direction === "upArrow" ? "older prompt" : "")
		expect(props.setCardScrollOffset).not.toHaveBeenCalled()
		app.unmount()
	})

	it.each(["@/src/example.ts ", "/condense "])("submits %j and toggles mode with completion disabled in NORMAL", (text) => {
		const props = createInputProps({
			textInputRef: { current: text },
			cursorPosRef: { current: text.length - 1 },
			isVimNormal: true,
			handleVimInput: vi.fn(() => false),
		})
		const app = render(<InputHarness {...props} />)
		pressKey({ return: true }, "\r")
		expect(props.handleSubmit).toHaveBeenCalledWith(text.trim(), [])
		pressKey({ tab: true }, "\t")
		expect(props.toggleMode).toHaveBeenCalledOnce()
		expect(props.setTextInput).not.toHaveBeenCalled()
		app.unmount()
	})

	it("routes Vim editing before approval shortcuts and text insertion", () => {
		const props = createInputProps({ handleVimInput: vi.fn(() => true), isVimNormal: true })
		const app = render(<InputHarness {...props} />)
		pressKey({}, "3")
		expect(props.handleVimInput).toHaveBeenCalledOnce()
		expect(props.handleAskShortcuts).not.toHaveBeenCalled()
		expect(props.handleButtonAction).not.toHaveBeenCalled()
		expect(props.insertTextAtCursor).not.toHaveBeenCalled()
		app.unmount()
	})

	it("leaves active Goal shortcuts ahead of Vim redo", () => {
		const props = createInputProps({ goalStatus: "paused", handleVimInput: vi.fn(() => true) })
		const app = render(<InputHarness {...props} />)
		pressKey({ ctrl: true }, "r")
		expect(props.handleGoalControl).toHaveBeenCalledWith("resume")
		expect(props.handleVimInput).not.toHaveBeenCalled()
		app.unmount()
	})

	it("does not send panel or terminal-control input to Vim", () => {
		const props = createInputProps({ activePanel: { type: "settings" }, handleVimInput: vi.fn(() => true) })
		const app = render(<InputHarness {...props} />)
		pressKey({}, "d")
		pressKey({}, "[4;991;1710t")
		expect(props.handleVimInput).not.toHaveBeenCalled()
		app.unmount()
	})
})
