import { DiracMessageType, UIActionButtonType } from "@shared/ExtensionMessage"
import type { GoalStatus } from "@shared/goal"
import { useInput } from "ink"
import { SHIFT_ENTER_SEQUENCES } from "../constants/keyboard"
import { getVisibleGlobalActionButtons } from "../utils/action-buttons"
import { readImageFromClipboard } from "../utils/clipboard-image"
import { moveCursorDown, moveCursorUp } from "../utils/cursor"
import { extractMentionQuery, insertMention } from "../utils/file-search"
import type { GoalLifecycleAction } from "../utils/goals"
import { isMouseEscapeSequence, isTerminalResponseSequence } from "../utils/input"
import { parseImagesFromInput } from "../utils/parser"
import {
	executeLocalSlashCommand,
	executeStandaloneLocalSlashCommand,
	extractSlashQuery,
	insertSlashCommand,
} from "../utils/slash-commands"
import { findWordEnd, findWordStart } from "./useTextInput"

export type GoalKeyboardShortcut = GoalLifecycleAction | "details"

export function getGoalKeyboardShortcut(
	input: string,
	key: { ctrl?: boolean },
	status?: GoalStatus,
): GoalKeyboardShortcut | undefined {
	if (!key.ctrl || status === undefined) return undefined
	if (input === "g" || input === "\u0007") return "details"
	if ((input === "p" || input === "\u0010") && (status === "working" || status === "waiting")) return "pause"
	if ((input === "r" || input === "\u0012") && (status === "paused" || status === "blocked")) return "resume"
	if ((input === "x" || input === "\u0018") && status !== "achieved" && status !== "stopped") return "stop"
	return undefined
}

interface UseChatInputHandlerProps {
	workspacePath: string
	inputColumns: number
	textInputRef: React.MutableRefObject<string>
	cursorPosRef: React.MutableRefObject<number>
	setTextInput: React.Dispatch<React.SetStateAction<string>>
	setCursorPos: (pos: number | ((prev: number) => number)) => void
	activePanel: any
	setActivePanel: (panel: any) => void
	handleAskShortcuts: (input: string, key: any, currentTextInput: string) => boolean
	handleKeyboardSequence: (input: string) => boolean
	handleCtrlShortcut: (input: string) => boolean
	handleVimInput?: (input: string, key: import("ink").Key) => boolean
	resetInput: () => void
	isVimNormal?: boolean
	insertTextAtCursor: (text: string) => void
	toggleMode: () => void
	toggleAutoApproveAll: () => void
	enableFastMode: () => void
	toggleQuietMode: () => void
	handleSubmit: (text: string, images: string[]) => void
	handleExit: () => void
	clearViewAndResetTask: () => void
	// Slash menu state
	filteredCommands: any[]
	selectedSlashIndex: number
	setSelectedSlashIndex: React.Dispatch<React.SetStateAction<number>>
	slashMenuDismissed: boolean
	setSlashMenuDismissed: (dismissed: boolean) => void
	// File menu state
	fileResults: any[]
	selectedIndex: number
	setSelectedIndex: React.Dispatch<React.SetStateAction<number>>
	setFileResults: (results: any[]) => void
	// History state
	getHistoryItems: () => string[]
	navigateHistory: (direction: "older" | "newer") => void
	historyIndex: number
	setHistoryIndex: (index: number) => void
	savedInput: string
	setSavedInput: (input: string) => void
	// Button state
	isSpinnerActive: boolean
	isProcessing: boolean
	yolo: boolean
	uiActionState: any
	pendingAsk: any
	handleButtonAction: (action: any, isPrimary: boolean, value?: string) => void
	isYoloSuppressed: (yolo: boolean, ask: any) => boolean
	// Paste state
	lastPasteTimeRef: React.MutableRefObject<number>
	activePasteNumRef: React.MutableRefObject<number>
	activePasteLinesRef: React.MutableRefObject<number>
	activePasteStartPosRef: React.MutableRefObject<number>
	pasteCounterRef: React.MutableRefObject<number>
	pasteUpdateTimeoutRef: React.MutableRefObject<NodeJS.Timeout | null>
	setPastedTexts: React.Dispatch<React.SetStateAction<Map<number, string>>>
	PASTE_COLLAPSE_THRESHOLD: number
	PASTE_CHUNK_WINDOW_MS: number
	PASTE_UPDATE_DEBOUNCE_MS: number
	// Other
	mode: string
	isEmptyConversation: boolean
	// Card scroll state
	scrollableCardMaxOffset: number
	cardScrollOffset: number
	setCardScrollOffset: (offset: number) => void
	goalStatus?: GoalStatus
	handleGoalControl: (action: GoalLifecycleAction) => void
	toggleGoalDetails: () => void
	disarmGoalStopConfirmation: () => void
}

export function useChatInputHandler({
	workspacePath,
	inputColumns,
	textInputRef,
	cursorPosRef,
	setTextInput,
	setCursorPos,
	activePanel,
	setActivePanel,
	handleAskShortcuts,
	handleKeyboardSequence,
	handleCtrlShortcut,
	handleVimInput,
	resetInput,
	isVimNormal = false,
	insertTextAtCursor,
	toggleMode,
	toggleAutoApproveAll,
	enableFastMode,
	toggleQuietMode,
	handleSubmit,
	handleExit,
	clearViewAndResetTask,
	filteredCommands,
	selectedSlashIndex,
	setSelectedSlashIndex,
	slashMenuDismissed,
	setSlashMenuDismissed,
	fileResults,
	selectedIndex,
	setSelectedIndex,
	setFileResults,
	getHistoryItems,
	navigateHistory,
	historyIndex,
	setHistoryIndex,
	savedInput,
	setSavedInput,
	isSpinnerActive,
	isProcessing,
	yolo,
	uiActionState,
	pendingAsk,
	handleButtonAction,
	isYoloSuppressed,
	lastPasteTimeRef,
	activePasteNumRef,
	activePasteLinesRef,
	activePasteStartPosRef,
	pasteCounterRef,
	pasteUpdateTimeoutRef,
	setPastedTexts,
	PASTE_COLLAPSE_THRESHOLD,
	PASTE_CHUNK_WINDOW_MS,
	PASTE_UPDATE_DEBOUNCE_MS,
	mode,
	isEmptyConversation,
	scrollableCardMaxOffset,
	cardScrollOffset,
	setCardScrollOffset,
	goalStatus,
	handleGoalControl,
	toggleGoalDetails,
	disarmGoalStopConfirmation,
}: UseChatInputHandlerProps) {
	useInput((input, key) => {
		const isShiftEnter = (key.return && key.shift) || SHIFT_ENTER_SEQUENCES.has(input)
		if (isMouseEscapeSequence(input) || (!isShiftEnter && isTerminalResponseSequence(input, key))) return
		if (activePanel) {
			disarmGoalStopConfirmation()
			return
		}

		const currentTextInput = textInputRef.current
		const currentCursorPos = cursorPosRef.current
		const currentMentionInfo = extractMentionQuery(currentTextInput, currentCursorPos)
		const currentSlashInfo = extractSlashQuery(currentTextInput, currentCursorPos)
		const localSlashCommandContext = {
			mode,
			setActivePanel,
			resetInputLine: resetInput,
			clearViewAndResetTask,
			handleExit,
			enableFastMode,
			toggleQuietMode,
		}

		const goalShortcut = getGoalKeyboardShortcut(input, key, goalStatus)
		if (goalShortcut === "details") {
			toggleGoalDetails()
			return
		}
		if (goalShortcut) {
			handleGoalControl(goalShortcut)
			return
		}
		disarmGoalStopConfirmation()

		if (key.ctrl && !key.shift && !key.meta && (key.upArrow || key.downArrow)) {
			navigateHistory(key.upArrow ? "older" : "newer")
			return
		}

		// Newline chords belong to the composer in either editing mode.
		if (isShiftEnter || (key.shift && key.downArrow)) {
			insertTextAtCursor("\n")
			return
		}

		if (handleVimInput?.(input, key)) {
			if (key.escape) {
				setSlashMenuDismissed(true)
				setFileResults([])
			}
			return
		}

		if (handleAskShortcuts(input, key, currentTextInput)) return
		if (handleKeyboardSequence(input)) return

		if (key.meta) {
			if (key.leftArrow) {
				setCursorPos(findWordStart(currentTextInput, currentCursorPos))
				return
			}
			if (key.rightArrow) {
				setCursorPos(findWordEnd(currentTextInput, currentCursorPos))
				return
			}
		}

		const inSlashMode = !isVimNormal && currentSlashInfo.inSlashMode
		const inMentionMode = !isVimNormal && currentMentionInfo.inMentionMode
		const inSlashMenu = inSlashMode && filteredCommands.length > 0 && !slashMenuDismissed
		const inFileMenu = inMentionMode && fileResults.length > 0 && !inSlashMenu

		if (inSlashMenu) {
			if (key.upArrow) {
				setSelectedSlashIndex((i) => Math.max(0, i - 1))
				return
			}
			if (key.downArrow) {
				setSelectedSlashIndex((i) => Math.min(filteredCommands.length - 1, i + 1))
				return
			}
			if (key.tab || key.return) {
				const cmd = filteredCommands[selectedSlashIndex]
				if (cmd) {
					const wasLocalCommand = executeLocalSlashCommand(cmd.name, localSlashCommandContext)

					if (wasLocalCommand) {
						setSelectedSlashIndex(0)
						setSlashMenuDismissed(true)
						return
					}

					const insertion = insertSlashCommand(
						currentTextInput,
						currentSlashInfo.slashIndex,
						cmd.name,
						currentCursorPos,
					)
					setTextInput(insertion.text)
					setCursorPos(insertion.cursorPosition)
					setSelectedSlashIndex(0)
				}
				return
			}
			if (key.escape) {
				setSlashMenuDismissed(true)
				setSelectedSlashIndex(0)
				return
			}
		}

		if (inFileMenu) {
			if (key.upArrow) {
				setSelectedIndex((i) => Math.max(0, i - 1))
				return
			}
			if (key.downArrow) {
				setSelectedIndex((i) => Math.min(fileResults.length - 1, i + 1))
				return
			}
			if (key.tab || key.return) {
				const file = fileResults[selectedIndex]
				if (file) {
					const insertion = insertMention(currentTextInput, currentMentionInfo.atIndex, file.path, currentCursorPos)
					setTextInput(insertion.text)
					setCursorPos(insertion.cursorPosition)
					setFileResults([])
					setSelectedIndex(0)
				}
				return
			}
			if (key.escape) {
				setFileResults([])
				setSelectedIndex(0)
				return
			}
		}

		if (key.upArrow && !inSlashMenu && !inFileMenu && isEmptyConversation) {
			const historyItems = getHistoryItems()
			if (historyItems.length > 0) {
				const canNavigate =
					currentTextInput === "" ||
					(historyIndex >= 0 && historyIndex < historyItems.length && currentTextInput === historyItems[historyIndex])
				if (canNavigate) {
					if (historyIndex === -1) setSavedInput(currentTextInput)
					const newIndex = Math.min(historyIndex + 1, historyItems.length - 1)
					if (newIndex !== historyIndex) {
						setHistoryIndex(newIndex)
						const historyText = historyItems[newIndex]
						setTextInput(historyText)
						setCursorPos(historyText.length)
					}
					return
				}
			}
		}

		if (key.downArrow && !inSlashMenu && !inFileMenu && isEmptyConversation) {
			const historyItems = getHistoryItems()
			if (historyIndex >= 0) {
				const canNavigate = historyIndex < historyItems.length && currentTextInput === historyItems[historyIndex]
				if (canNavigate) {
					const newIndex = historyIndex - 1
					if (newIndex >= 0) {
						setHistoryIndex(newIndex)
						const historyText = historyItems[newIndex]
						setTextInput(historyText)
						setCursorPos(historyText.length)
					} else {
						setHistoryIndex(-1)
						setTextInput(savedInput)
						setCursorPos(savedInput.length)
					}
					return
				}
			}
		}

		const currentUiActionState = uiActionState || {}
		const globalButtons = getVisibleGlobalActionButtons(currentUiActionState.globalButtons || [])
		const buttons = [...globalButtons, ...(currentUiActionState.cardButtons || [])]

		if (
			buttons.length > 0 &&
			!isProcessing &&
			currentTextInput === "" &&
			(!pendingAsk || !isYoloSuppressed(yolo, pendingAsk))
		) {
			const num = Number.parseInt(input, 10)
			if (!Number.isNaN(num) && num >= 1 && num <= buttons.length) {
				handleButtonAction(buttons[num - 1].action, true, buttons[num - 1].value)
				return
			}
		}

		const card = pendingAsk?.content?.type === DiracMessageType.CARD ? pendingAsk.content.card : null
		if (currentTextInput === "" && !isProcessing) {
			if (card?.actions && card.actions.length > 0) {
				const num = Number.parseInt(input, 10)
				if (!Number.isNaN(num) && num >= 1 && num <= card.actions.length) {
					handleButtonAction(UIActionButtonType.UTILITY, false, card.actions[num - 1].value)
					return
				}
			}
		}

		if (key.ctrl && (input === "v" || input === "\u0016")) {
			// Try to read image from clipboard in the background.
			// We don't return here so that the terminal can still perform its default paste behavior for text.
			void (async () => {
				// Only attempt if not in an SSH session to avoid unnecessary tool calls that will fail anyway
				if (!(process.env.SSH_CONNECTION || process.env.SSH_CLIENT || process.env.SSH_TTY)) {
					const imagePath = await readImageFromClipboard()
					if (imagePath) {
						// Clipboard images are absolute temporary files. `@/…` is reserved
						// for workspace-relative mentions, so insert a standalone quoted path.
						insertTextAtCursor(`"${imagePath}" `)
					}
				}
			})()
		}

		if (key.ctrl && input && handleCtrlShortcut(input)) return

		if (input && input.length > PASTE_COLLAPSE_THRESHOLD) {
			const now = Date.now()
			const timeSinceLastPaste = now - lastPasteTimeRef.current
			lastPasteTimeRef.current = now

			if (timeSinceLastPaste < PASTE_CHUNK_WINDOW_MS && activePasteNumRef.current > 0) {
				const pasteNum = activePasteNumRef.current
				const chunkLines = input.match(/[\r\n]/g)?.length || 0
				activePasteLinesRef.current += chunkLines

				setPastedTexts((prev) => {
					const next = new Map(prev)
					next.set(pasteNum, (next.get(pasteNum) || "") + input)
					return next
				})

				if (pasteUpdateTimeoutRef.current) clearTimeout(pasteUpdateTimeoutRef.current)
				pasteUpdateTimeoutRef.current = setTimeout(() => {
					const newPlaceholder = `[Pasted text #${pasteNum} +${activePasteLinesRef.current} lines]`
					const pattern = new RegExp(`\\[Pasted text #${pasteNum} \\+\\d+ lines\\]`)
					const latestText = textInputRef.current
					const match = pattern.exec(latestText)
					if (!match) return

					const oldPlaceholderEnd = match.index + match[0].length
					const cursorWasAfterPlaceholder = cursorPosRef.current === oldPlaceholderEnd
					setTextInput((text) => text.replace(pattern, newPlaceholder))
					if (cursorWasAfterPlaceholder) {
						setCursorPos(match.index + newPlaceholder.length)
					}
				}, PASTE_UPDATE_DEBOUNCE_MS)
				return
			}

			pasteCounterRef.current += 1
			const pasteNum = pasteCounterRef.current
			activePasteNumRef.current = pasteNum
			activePasteStartPosRef.current = currentCursorPos
			const extraLines = input.match(/[\r\n]/g)?.length || 0
			activePasteLinesRef.current = extraLines
			const placeholder = `[Pasted text #${pasteNum} +${extraLines} lines]`
			setPastedTexts((prev) => {
				const next = new Map(prev)
				next.set(pasteNum, input)
				return next
			})
			const newText = currentTextInput.slice(0, currentCursorPos) + placeholder + currentTextInput.slice(currentCursorPos)
			setTextInput(newText)
			setCursorPos(currentCursorPos + placeholder.length)
			return
		}

		if (key.return && (key.meta || input === "\n")) {
			insertTextAtCursor("\n")
			return
		}
		if (key.shift && key.tab) {
			toggleAutoApproveAll()
			return
		}
		if (key.tab && !inMentionMode && !inSlashMode) {
			toggleMode()
			return
		}
		if (key.return && !key.shift && !key.meta && input !== "\n" && !inMentionMode) {
			// Runtime eligibility belongs to handleSubmit, which can accept input while a root sleeps.
			if (
				(!isSpinnerActive || goalStatus !== undefined) &&
				!isProcessing &&
				executeStandaloneLocalSlashCommand(currentTextInput, localSlashCommandContext)
			) {
				setSelectedSlashIndex(0)
				setSlashMenuDismissed(true)
				return
			}
			if (inSlashMode) return
			const { prompt: currentPrompt, imagePaths: currentImagePaths } = parseImagesFromInput(currentTextInput, workspacePath)
			if (currentPrompt.trim() || currentImagePaths.length > 0) {
				handleSubmit(currentPrompt.trim(), currentImagePaths)
			}
			return
		}

		if (key.leftArrow && !inSlashMenu && !inFileMenu) {
			setCursorPos((pos) => Math.max(0, pos - 1))
			return
		}
		if (key.rightArrow && !inSlashMenu && !inFileMenu) {
			setCursorPos((pos) => Math.min(currentTextInput.length, pos + 1))
			return
		}
		if ((key.upArrow || key.downArrow) && !inSlashMenu && !inFileMenu) {
			const nextCursorPos = key.upArrow
				? moveCursorUp(currentTextInput, currentCursorPos, inputColumns)
				: moveCursorDown(currentTextInput, currentCursorPos, inputColumns)
			if (nextCursorPos !== currentCursorPos) {
				setCursorPos(nextCursorPos)
				return
			}

			// Scroll the response only when the cursor cannot move farther in the prompt.
			const nextScrollOffset = key.upArrow
				? Math.min(cardScrollOffset + 1, scrollableCardMaxOffset)
				: Math.max(cardScrollOffset - 1, 0)
			if (nextScrollOffset !== cardScrollOffset) setCardScrollOffset(nextScrollOffset)
			return
		}

		if (input && !key.ctrl && !key.meta && !key.upArrow && !key.downArrow && !key.tab) {
			insertTextAtCursor(input)
		}
	})
}
