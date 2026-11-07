import React, { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react"
import type { SlashCommandInfo } from "@shared/proto/dirac/slash"
import { EmptyRequest } from "@shared/proto/dirac/common"
import { CLI_ONLY_COMMANDS } from "@shared/slashCommands"
import { getAvailableSlashCommands } from "@/core/controller/slash/getAvailableSlashCommands"
import { StateManager } from "@/core/storage/StateManager"
import { arePathsEqual } from "@/utils/path"
import { UIActionButtonType, type DiracMessage } from "@shared/ExtensionMessage"
import { getUserPrompts } from "@shared/messages/prompt-history"
import type { DiracAskResponse } from "@shared/WebviewMessage"
import { Logger } from "@/shared/services/Logger"

import { useHomeEndKeys } from "./useHomeEndKeys"
import { useRawBackspaceKeys } from "./useRawBackspaceKeys"
import { useTextInput } from "./useTextInput"
import { useVimInput } from "./useVimInput"
import { createVimEditor, type VimEditorState } from "../utils/vim-editor"
import { usePromptHistory } from "./usePromptHistory"
import { useChatInputHandler } from "./useChatInputHandler"
import {
	checkAndWarnRipgrepMissing,
	extractMentionQuery,
	type FileSearchResult,
	searchWorkspaceFiles,
} from "../utils/file-search"
import { parseImagesFromInput } from "../utils/parser"
import { extractSlashQuery, filterCommands, mergeCliSlashCommands } from "../utils/slash-commands"
import { getInputStorageKey } from "../utils/chat"
import { CliPanelType } from "../types"
import type { GoalStatus } from "@shared/goal"
import type { GoalLifecycleAction } from "../utils/goals"

export type ActivePanel =
	| {
			type: CliPanelType.SETTINGS
			initialMode?: "model-picker" | "featured-models" | "provider-picker"
			initialModelKey?: "actModelId" | "planModelId"
	  }
	| { type: CliPanelType.HISTORY }
	| { type: CliPanelType.HELP }
	| { type: CliPanelType.SKILLS }
	| { type: CliPanelType.USAGE }
	| { type: CliPanelType.AGENTS }
	| null

interface PersistedInputState {
	text: string
	cursorPos: number
	pastedTexts: Map<number, string>
	pasteCounter: number
	vimState: VimEditorState
}

const inputStateStorage = new Map<string, PersistedInputState>()

const SEARCH_DEBOUNCE_MS = 150
const RIPGREP_WARNING_DURATION_MS = 5000
const MAX_SEARCH_RESULTS = 15
const PASTE_COLLAPSE_THRESHOLD = 10000
const PASTE_CHUNK_WINDOW_MS = 150
const PASTE_UPDATE_DEBOUNCE_MS = 50
const MAX_HISTORY_ITEMS = 20

export interface ComposerActions {
	handleAskShortcuts: (input: string, key: any, currentTextInput: string) => boolean
	handleSubmit: (text: string, images: string[]) => void
	handleExit: () => void
	clearViewAndResetTask: () => void
	handleButtonAction: (
		action: UIActionButtonType | string | DiracAskResponse | undefined,
		isPrimary: boolean,
		value?: string,
	) => void
	toggleMode: () => void
	toggleAutoApproveAll: () => void
	enableFastMode: () => void
	toggleQuietMode: () => void
	showAgentSnapshot: () => void
}

interface UseComposerProps {
	ctrl: any
	taskId?: string
	messages?: DiracMessage[]
	onHistoryError?: (error: unknown) => void
	mode: string
	workspacePath: string
	inputColumns: number
	activePanel: ActivePanel
	setActivePanel: React.Dispatch<React.SetStateAction<ActivePanel>>
	isSpinnerActive: boolean
	isProcessing: boolean
	uiActionState: any
	yolo: boolean
	pendingAsk: any
	actionsRef: React.MutableRefObject<ComposerActions>
	isYoloSuppressed: (yolo: boolean, ask: any) => boolean
	isEmptyConversation: boolean
	scrollableCardMaxOffset: number
	cardScrollOffset: number
	setCardScrollOffset: (offset: number) => void
	goalStatus?: GoalStatus
	handleGoalControl: (action: GoalLifecycleAction) => void
	toggleGoalDetails: () => void
	disarmGoalStopConfirmation: () => void
}

export function useComposer({
	ctrl,
	taskId,
	messages = [],
	onHistoryError = (error) => Logger.error("Failed to load prompt history:", error),
	mode,
	workspacePath,
	inputColumns,
	activePanel,
	setActivePanel,
	isSpinnerActive,
	isProcessing,
	uiActionState,
	yolo,
	pendingAsk,
	actionsRef,
	isYoloSuppressed,

	isEmptyConversation,
	scrollableCardMaxOffset,
	cardScrollOffset,
	setCardScrollOffset,
	goalStatus,
	handleGoalControl,
	toggleGoalDetails,
	disarmGoalStopConfirmation,
}: UseComposerProps) {
	const {
		text: textInput,
		cursorPos,
		setText,
		setCursorPos,
		setValue,
		handleKeyboardSequence,
		handleCtrlShortcut: applyCtrlShortcut,
		deleteCharsBefore,
		deleteCharsAfter,
		insertText,
		getText,
		getCursorPos,
	} = useTextInput()

	const storageKey = getInputStorageKey(ctrl, taskId)
	const stateManager = StateManager.get()
	const subscribeVimSetting = useCallback((listener: () => void) => stateManager.subscribe(listener), [stateManager])
	const readVimSetting = useCallback(() => stateManager.getGlobalSettingsKey("cliVimMode"), [stateManager])
	const vimEnabled = useSyncExternalStore(subscribeVimSetting, readVimSetting)
	const { vimState, vimMode, handleVimInput, resetVimInput, restoreVimDraft, editWithVimHistory } = useVimInput({
		enabled: vimEnabled,
		getText,
		getCursorPos,
		setValue,
	})
	const setTextInput = useCallback(
		(text: string | ((prev: string) => string)) => editWithVimHistory(() => setText(text)),
		[editWithVimHistory, setText],
	)
	const insertTextAtCursor = useCallback(
		(text: string) => editWithVimHistory(() => insertText(text)),
		[editWithVimHistory, insertText],
	)
	const handleCtrlShortcut = useCallback(
		(input: string) => editWithVimHistory(() => applyCtrlShortcut(input)),
		[editWithVimHistory, applyCtrlShortcut],
	)
	const textInputRef = useMemo(
		() => ({
			get current() {
				return getText()
			},
		}),
		[getText],
	)
	const cursorPosRef = useMemo(
		() => ({
			get current() {
				return getCursorPos()
			},
		}),
		[getCursorPos],
	)

	const [pastedTexts, setPastedTexts] = useState<Map<number, string>>(() => {
		return inputStateStorage.get(storageKey)?.pastedTexts ?? new Map()
	})
	const pasteCounterRef = useRef<number>(inputStateStorage.get(storageKey)?.pasteCounter ?? 0)
	const lastPasteTimeRef = useRef<number>(0)
	const activePasteNumRef = useRef<number>(0)
	const activePasteStartPosRef = useRef<number>(0)
	const activePasteLinesRef = useRef<number>(0)
	const pasteUpdateTimeoutRef = useRef<NodeJS.Timeout | null>(null)
	const ripgrepWarningTimeoutRef = useRef<NodeJS.Timeout | null>(null)

	const [fileResults, setFileResults] = useState<FileSearchResult[]>([])
	const [selectedIndex, setSelectedIndex] = useState(0)
	const [historyIndex, setHistoryIndex] = useState(-1)
	const [savedInput, setSavedInput] = useState("")
	const [isSearching, setIsSearching] = useState(false)
	const [fileSearchError, setFileSearchError] = useState<string | null>(null)
	const [showRipgrepWarning, setShowRipgrepWarning] = useState(false)

	const [availableCommands, setAvailableCommands] = useState<SlashCommandInfo[]>([])
	const [selectedSlashIndex, setSelectedSlashIndex] = useState(0)
	const [slashMenuDismissed, setSlashMenuDismissed] = useState(false)
	const lastSlashIndexRef = useRef<number>(-1)

	const searchRef = useRef({
		searchTimeout: null as NodeJS.Timeout | null,
		lastQuery: null as string | null,
		hasCheckedRipgrep: false,
		requestId: 0,
	})
	const skipNextPersistRef = useRef(false)

	const resetPasteChunks = useCallback(() => {
		if (pasteUpdateTimeoutRef.current) clearTimeout(pasteUpdateTimeoutRef.current)
		pasteUpdateTimeoutRef.current = null
		activePasteNumRef.current = 0
		lastPasteTimeRef.current = 0
	}, [])
	const runId = taskId ?? ctrl?.task?.taskId
	const loadHistory = useCallback(
		async () => (ctrl ? ctrl.getPromptHistory(workspacePath, runId) : []),
		[ctrl, workspacePath, runId],
	)
	const { navigateHistory, resetHistory } = usePromptHistory({
		scopeKey: `${workspacePath}:${storageKey}`,
		loadHistory,
		currentPrompts: getUserPrompts(messages),
		captureDraft: (): PersistedInputState => ({
			text: getText(),
			cursorPos: getCursorPos(),
			pastedTexts: new Map(pastedTexts),
			pasteCounter: pasteCounterRef.current,
			vimState,
		}),
		restoreDraft: (draft) => {
			resetPasteChunks()
			restoreVimDraft(draft, draft.vimState)
			setPastedTexts(new Map(draft.pastedTexts))
			pasteCounterRef.current = draft.pasteCounter
		},
		recallText: (text) => {
			resetPasteChunks()
			const value = { text, cursorPos: text.length }
			restoreVimDraft(value, createVimEditor(value, vimMode ?? "insert"))
			setPastedTexts(new Map())
			pasteCounterRef.current = 0
		},
		onError: onHistoryError,
	})

	const handleHome = useCallback(() => {
		if (vimMode === "normal") handleVimInput("0", {})
		else setCursorPos(0)
	}, [vimMode, handleVimInput, setCursorPos])
	const handleEnd = useCallback(() => {
		if (vimMode === "normal") handleVimInput("$", {})
		else setCursorPos(textInputRef.current.length)
	}, [vimMode, handleVimInput, setCursorPos, textInputRef])

	useHomeEndKeys({
		onHome: handleHome,
		onEnd: handleEnd,
		isActive: !activePanel,
	})

	useRawBackspaceKeys({
		onBackspace: (count) => {
			if (vimMode === "normal") handleVimInput("h", {}, count)
			else deleteCharsBefore(count)
		},
		onDelete: (count) => {
			if (vimMode === "normal") handleVimInput("x", {}, count)
			else deleteCharsAfter(count)
		},
		isActive: !activePanel,
	})

	useEffect(() => {
		skipNextPersistRef.current = true
		const stored = inputStateStorage.get(storageKey)
		restoreVimDraft({ text: stored?.text ?? "", cursorPos: stored?.cursorPos ?? 0 }, stored?.vimState)
		setPastedTexts(new Map(stored?.pastedTexts))
		pasteCounterRef.current = stored?.pasteCounter ?? 0
	}, [storageKey, restoreVimDraft])

	useEffect(() => {
		if (skipNextPersistRef.current) {
			skipNextPersistRef.current = false
			return
		}
		if (textInput || pastedTexts.size > 0 || vimMode === "normal") {
			inputStateStorage.set(storageKey, {
				text: textInput,
				cursorPos,
				pastedTexts: new Map(pastedTexts),
				pasteCounter: pasteCounterRef.current,
				vimState,
			})
			return
		}

		inputStateStorage.delete(storageKey)
	}, [storageKey, textInput, cursorPos, pastedTexts, vimState, vimMode])

	const mentionInfo = useMemo(() => extractMentionQuery(textInput, cursorPos), [textInput, cursorPos])
	const slashInfo = useMemo(() => extractSlashQuery(textInput, cursorPos), [textInput, cursorPos])
	const filteredCommands = useMemo(
		() => filterCommands(availableCommands, slashInfo.query),
		[availableCommands, slashInfo.query],
	)

	useEffect(() => {
		if (slashInfo.slashIndex !== lastSlashIndexRef.current) {
			lastSlashIndexRef.current = slashInfo.slashIndex
			setSlashMenuDismissed(false)
			setSelectedSlashIndex(0)
		}
	}, [slashInfo.slashIndex])

	useEffect(() => {
		const cliOnlyCommands: SlashCommandInfo[] = CLI_ONLY_COMMANDS.map((cmd) => ({
			name: cmd.name,
			description: cmd.description || "",
			section: cmd.section || "default",
			cliCompatible: true,
		}))
		setAvailableCommands(cliOnlyCommands)
		if (!ctrl) return

		let cancelled = false
		getAvailableSlashCommands(ctrl, EmptyRequest.create()).then(
			(response) => {
				if (cancelled) return
				const backendCommands = response.commands.filter((cmd) => cmd.cliCompatible !== false)
				setAvailableCommands(mergeCliSlashCommands(cliOnlyCommands, backendCommands))
			},
			(error) => {
				Logger.error("Failed to load slash commands:", error)
			},
		)

		return () => {
			cancelled = true
		}
	}, [ctrl])

	useEffect(() => {
		return () => {
			searchRef.current.requestId += 1
			if (searchRef.current.searchTimeout) clearTimeout(searchRef.current.searchTimeout)
			if (pasteUpdateTimeoutRef.current) clearTimeout(pasteUpdateTimeoutRef.current)
			if (ripgrepWarningTimeoutRef.current) clearTimeout(ripgrepWarningTimeoutRef.current)
		}
	}, [])

	const getHistoryItems = useCallback(() => {
		const history = StateManager.get().getGlobalStateKey("taskHistory")
		if (!history?.length) return []
		const filtered = [...history]
			.filter((item) =>
				Boolean(
					(item.cwdOnTaskInitialization && arePathsEqual(item.cwdOnTaskInitialization, workspacePath)) ||
						(item.workspaceRootPath && arePathsEqual(item.workspaceRootPath, workspacePath)) ||
						(item.shadowGitConfigWorkTree && arePathsEqual(item.shadowGitConfigWorkTree, workspacePath)),
				),
			)
			.reverse()
			.map((item) => item.task)
			.slice(0, MAX_HISTORY_ITEMS)
			.filter(Boolean) as string[]
		return [...new Set(filtered)]
	}, [workspacePath])

	useEffect(() => {
		const { current: r } = searchRef
		if (!mentionInfo.inMentionMode) {
			r.requestId += 1
			r.lastQuery = null
			setFileResults([])
			setSelectedIndex(0)
			setIsSearching(false)
			setFileSearchError(null)
			if (r.searchTimeout) {
				clearTimeout(r.searchTimeout)
				r.searchTimeout = null
			}
			return
		}
		if (!r.hasCheckedRipgrep) {
			r.hasCheckedRipgrep = true
			if (checkAndWarnRipgrepMissing()) {
				setShowRipgrepWarning(true)
				ripgrepWarningTimeoutRef.current = setTimeout(() => setShowRipgrepWarning(false), RIPGREP_WARNING_DURATION_MS)
			}
		}
		const { query } = mentionInfo
		if (query === r.lastQuery) return
		r.lastQuery = query
		if (r.searchTimeout) clearTimeout(r.searchTimeout)
		setIsSearching(true)
		setFileSearchError(null)
		const requestId = ++r.requestId
		r.searchTimeout = setTimeout(async () => {
			try {
				let results: FileSearchResult[]
				if (query.toLowerCase().startsWith("image")) {
					let imageQuery = ""
					if (query.toLowerCase() === "image") {
						imageQuery = ""
					} else if (query.toLowerCase().startsWith("image:")) {
						imageQuery = query.slice(6)
					} else {
						imageQuery = query.slice(5)
					}
					results = await searchWorkspaceFiles(imageQuery, workspacePath, MAX_SEARCH_RESULTS, "file", [
						"png",
						"jpg",
						"jpeg",
						"gif",
						"webp",
					])
				} else {
					results = await searchWorkspaceFiles(query, workspacePath, MAX_SEARCH_RESULTS)
				}
				if (requestId === r.requestId) {
					setFileResults(results)
					setSelectedIndex(0)
				}
			} catch (error) {
				Logger.error("Failed to search workspace files:", error)
				if (requestId === r.requestId) {
					setFileResults([])
					setFileSearchError(error instanceof Error ? error.message : String(error))
				}
			} finally {
				if (requestId === r.requestId) setIsSearching(false)
			}
		}, SEARCH_DEBOUNCE_MS)
		return () => {
			if (r.searchTimeout) clearTimeout(r.searchTimeout)
		}
	}, [mentionInfo.inMentionMode, mentionInfo.query, workspacePath])

	const resetInput = useCallback(() => {
		resetHistory()
		resetPasteChunks()
		setHistoryIndex(-1)
		setSavedInput("")
		resetVimInput()
		setPastedTexts(new Map())
		pasteCounterRef.current = 0
		inputStateStorage.delete(storageKey)
	}, [storageKey, resetVimInput, resetHistory, resetPasteChunks])

	useChatInputHandler({
		workspacePath,
		inputColumns,
		isEmptyConversation,
		textInputRef,
		cursorPosRef,
		setTextInput,
		setCursorPos,
		activePanel,
		setActivePanel,
		handleAskShortcuts: (input, key, currentTextInput) => actionsRef.current.handleAskShortcuts(input, key, currentTextInput),
		showAgentSnapshot: () => actionsRef.current.showAgentSnapshot(),
		handleKeyboardSequence,
		handleCtrlShortcut,
		handleVimInput,
		resetInput,
		isVimNormal: vimMode === "normal",
		insertTextAtCursor,
		toggleMode: () => actionsRef.current.toggleMode(),
		toggleAutoApproveAll: () => actionsRef.current.toggleAutoApproveAll(),
		enableFastMode: () => actionsRef.current.enableFastMode(),
		toggleQuietMode: () => actionsRef.current.toggleQuietMode(),
		handleSubmit: (text, images) => actionsRef.current.handleSubmit(text, images),
		handleExit: () => actionsRef.current.handleExit(),
		clearViewAndResetTask: () => actionsRef.current.clearViewAndResetTask(),
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
		uiActionState,
		yolo,
		pendingAsk,
		handleButtonAction: (action, isPrimary, value) => actionsRef.current.handleButtonAction(action, isPrimary, value),
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
		scrollableCardMaxOffset,
		cardScrollOffset,
		setCardScrollOffset,
		goalStatus,
		handleGoalControl,
		toggleGoalDetails,
		disarmGoalStopConfirmation,
	})

	const { imagePaths } = parseImagesFromInput(textInput, workspacePath)
	const showSlashMenu = vimMode !== "normal" && slashInfo.inSlashMode && !slashMenuDismissed
	const showFileMenu = vimMode !== "normal" && mentionInfo.inMentionMode && !showSlashMenu

	return {
		vimMode,
		textInput,
		cursorPos,
		setTextInput,
		setCursorPos,
		pastedTexts,
		pasteCounterRef,
		storageKey,
		resetInput,
		availableCommands,
		availableCommandNames: availableCommands.map((command) => command.name),
		filteredCommands,
		selectedSlashIndex,
		slashInfo,
		showSlashMenu,
		fileResults,
		selectedIndex,
		mentionInfo,
		showFileMenu,
		isSearching,
		showRipgrepWarning,
		fileSearchError,
		imagePaths,
	}
}
