/**
 * Unified Chat View component
 * Combines the welcome screen layout with task message display
 * Messages appear above the input field, input stays at bottom
 *
 * IMPORTANT: Rendering Architecture
 * ===============================
 *
 * To ensure a flicker-free experience in the terminal, we use a multi-layered approach:
 *
 * 1. Modern Rendering Engine (@jrichman/ink@7.0.0):
 *    - Synchronized Update Mode: Batches terminal writes into atomic frames.
 *    - Incremental Rendering: Only sends changed lines to the terminal.
 *    - Resize Recovery: useTerminalSize hook forces a full remount on resize to reset
 *      Ink's line tracking and prevent "ghosting" artifacts.
 *
 * 2. Static + Dynamic Split:
 *    We use Ink's <Static> component to split content into two regions:
 *    - Static Region: Header and completed messages. Rendered once, scrolls up like
 *      terminal logs, and has zero re-render overhead.
 *    - Dynamic Region: Current streaming message and input UI. Kept small to ensure
 *      efficient line-erasing and synchronized updates.
 *
 * References:
 * - @jrichman/ink fork: https://github.com/jacob314/ink
 * - Gemini CLI: https://github.com/google-gemini/gemini-cli
 *
 * Input Responsiveness and State Integrity
 * ========================================
 *
 * To prevent input lag and cursor "ghosting" (especially under high load):
 * 1. Atomic State: text and cursorPos are updated together in a single state object
 *    in useTextInput to ensure they never get out of sync.
 * 2. Synchronous Mirror: A ref mirror provides the "hot-path" source of truth
 *    for input handlers, bypassing React's asynchronous render cycle to avoid
 *    stale closures during rapid typing.
 * 3. Coalesced Deletion: Raw stdin is parsed to count repeated backspace/delete
 *    bytes, allowing them to be processed in a single batch rather than one-by-one,
 *    which reduces re-render pressure.
 * - log-update: node_modules/ink/build/log-update.js (eraseLines logic)
 */

import type { ApiProvider, ModelInfo } from "@shared/api"

import { DiracMessageType, UIActionButtonType } from "@shared/ExtensionMessage"
import { DiracAskResponse } from "@shared/WebviewMessage"
import { getApiMetrics, getLastApiReqTotalTokens } from "@shared/getApiMetrics"
import { EmptyRequest } from "@shared/proto/dirac/common"
import type { SlashCommandInfo } from "@shared/proto/dirac/slash"
import { CLI_ONLY_COMMANDS } from "@shared/slashCommands"
import { getProviderDefaultModelId, getProviderModelIdKey } from "@shared/storage"
import { getRandomQuote } from "@/shared/quotes"
import type { Mode } from "@shared/storage/types"
import { Box, Static, Text, useStdout } from "ink"
import path from "node:path"
import Image from "ink-picture"
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { getAvailableSlashCommands } from "@/core/controller/slash/getAvailableSlashCommands"
import { StateManager } from "@/core/storage/StateManager"
import { COLORS } from "../constants/colors"
import { useTaskContext, useTaskState } from "../context/TaskContext"
import { useHomeEndKeys } from "../hooks/useHomeEndKeys"
import { useRawBackspaceKeys } from "../hooks/useRawBackspaceKeys"
import { useIsSpinnerActive, useLastCompletedAskMessage } from "../hooks/useStateSubscriber"
import { useTextInput } from "../hooks/useTextInput"
import { setTerminalTitle } from "../utils/display"
import {
    checkAndWarnRipgrepMissing,
    extractMentionQuery,
    type FileSearchResult, searchWorkspaceFiles
} from "../utils/file-search"
import { parseImagesFromInput, processImagePaths } from "../utils/parser"
import { extractSlashQuery, filterCommands, sortCommandsWorkflowsFirst } from "../utils/slash-commands"
import { ActionButtons } from "./ActionButtons"

import { AskPrompt } from "./AskPrompt"
import { ChatMessage } from "./ChatMessage"
import { FileMentionMenu } from "./FileMentionMenu"
import { HelpPanelContent } from "./HelpPanelContent"
import { HistoryPanelContent } from "./HistoryPanelContent"
import { providerModels } from "./ModelPicker"
import { SettingsPanelContent } from "./SettingsPanelContent"
import { SkillsPanelContent } from "./SkillsPanelContent"
import { SlashCommandMenu } from "./SlashCommandMenu"
import { ThinkingIndicator } from "./ThinkingIndicator"
import { ChatFooter } from "./ChatFooter"
import { ChatHeader } from "./ChatHeader"
import { ChatInputBar } from "./ChatInputBar"
import { useChatInputHandler } from "../hooks/useChatInputHandler"
import { useChatMessages } from "../hooks/useChatMessages"
import { useChatTask } from "../hooks/useChatTask"
import {
    expandPastedTexts,
    getAskPromptType,
    getInputStorageKey,
    isYoloSuppressed,
    parseAskOptions,
} from "../utils/chat"
import { getGitBranch, getGitDiffStats, type GitDiffStats } from "../utils/git"

/**
 * Persistent input storage that survives React remounts (e.g., during terminal resize).
 * Keyed by a stable identifier so each task/session maintains its own input state.
 */
interface PersistedInputState {
    text: string
    cursorPos: number
    pastedTexts: Map<number, string>
    pasteCounter: number
}

const inputStateStorage = new Map<string, PersistedInputState>()


interface ChatViewProps {
    controller?: any
    onExit?: () => void
    onComplete?: () => void
    onError?: () => void
    initialPrompt?: string
    initialImages?: string[]
    taskId?: string
}

const SEARCH_DEBOUNCE_MS = 150
const RIPGREP_WARNING_DURATION_MS = 5000
const MAX_SEARCH_RESULTS = 15
const DEFAULT_CONTEXT_WINDOW = 200000
const PASTE_COLLAPSE_THRESHOLD = 10000 // Characters before showing placeholder
const MAX_HISTORY_ITEMS = 20 // Max history items to navigate with up/down arrows

export const ChatView: React.FC<ChatViewProps> = ({
    controller,
    onExit,
    onComplete: _onComplete,
    onError,
    initialPrompt,
    initialImages,
    taskId,
}) => {
    const quote = useMemo(() => getRandomQuote(), [])
    const { stdout } = useStdout()
    const taskState = useTaskState()
    const { controller: taskController, clearState } = useTaskContext()
    const { isActive: isSpinnerActive, startTime: spinnerStartTime } = useIsSpinnerActive()
    const ctrl = useMemo(() => controller || taskController, [controller, taskController])

    const {
        text: textInput,
        cursorPos,
        setText: setTextInput,
        setCursorPos,
        handleKeyboardSequence,
        handleCtrlShortcut,
        deleteCharsBefore,
        deleteCharsAfter,
        insertText: insertTextAtCursor,
        getText,
        getCursorPos,
    } = useTextInput()

    const storageKey = useMemo(() => getInputStorageKey(ctrl, taskId), [ctrl, taskId])
    const textInputRef = useMemo(() => ({ get current() { return getText() } }), [getText])
    const cursorPosRef = useMemo(() => ({ get current() { return getCursorPos() } }), [getCursorPos])

    const [fileResults, setFileResults] = useState<FileSearchResult[]>([])
    const [selectedIndex, setSelectedIndex] = useState(0)
    const [historyIndex, setHistoryIndex] = useState(-1)
    const [savedInput, setSavedInput] = useState("")
    const [isSearching, setIsSearching] = useState(false)
    const [showRipgrepWarning, setShowRipgrepWarning] = useState(false)
    const [respondedToAsk, setRespondedToAsk] = useState<number | null>(null)
    const [userScrolled, setUserScrolled] = useState(false)
    const [cardExpansions, setCardExpansions] = useState<Map<string, "auto" | "expanded" | "collapsed">>(new Map())

    const toggleCardExpansion = useCallback((cardId: string) => {
        setCardExpansions((prev) => {
            const next = new Map(prev)
            const current = next.get(cardId) ?? "auto"
            next.set(cardId, current === "expanded" ? "collapsed" : "expanded")
            return next
        })
    }, [])

    const handleCardCollapse = useCallback((cardId: string) => {
        setCardExpansions((prev) => {
            const next = new Map(prev)
            next.set(cardId, "collapsed")
            return next
        })
    }, [])

    const getIsCardExpanded = (card: { id: string; collapsed?: boolean }): boolean => {
        const expansion = cardExpansions.get(card.id)
        if (expansion === "expanded") return true
        if (expansion === "collapsed") return false
        // "auto" or undefined: respect the tool's `collapsed` preference
        return card.collapsed === false
    }

    const [pastedTexts, setPastedTexts] = useState<Map<number, string>>(() => {
        return inputStateStorage.get(storageKey)?.pastedTexts ?? new Map()
    })
    const pasteCounterRef = useRef<number>(inputStateStorage.get(storageKey)?.pasteCounter ?? 0)
    const lastPasteTimeRef = useRef<number>(0)
    const activePasteNumRef = useRef<number>(0)
    const activePasteStartPosRef = useRef<number>(0)
    const activePasteLinesRef = useRef<number>(0)
    const pasteUpdateTimeoutRef = useRef<NodeJS.Timeout | null>(null)

    const [availableCommands, setAvailableCommands] = useState<SlashCommandInfo[]>([])
    const [selectedSlashIndex, setSelectedSlashIndex] = useState(0)
    const [slashMenuDismissed, setSlashMenuDismissed] = useState(false)
    const lastSlashIndexRef = useRef<number>(-1)

    const [activePanel, setActivePanel] = useState<
        | {
            type: "settings"
            initialMode?: "model-picker" | "featured-models" | "provider-picker"
            initialModelKey?: "actModelId" | "planModelId"
        }
        | { type: "history" }
        | { type: "help" }
        | { type: "skills" }
        | null
    >(null)

    const [gitBranch, setGitBranch] = useState<string | null>(null)
    const [gitDiffStats, setGitDiffStats] = useState<GitDiffStats | null>(null)

    const [mode, setMode] = useState<Mode>(() => {
        const stateManager = StateManager.get()
        return stateManager.getGlobalSettingsKey("mode") || "act"
    })

    const [yolo, setYolo] = useState<boolean>(() => StateManager.get().getGlobalSettingsKey("yoloModeToggled") ?? false)
    const [autoApproveAll, setAutoApproveAll] = useState<boolean>(
        () => StateManager.get().getGlobalSettingsKey("autoApproveAllToggled") ?? false,
    )

    const { displayMessages, committedMessages, liveMessages, taskSwitchKey, setTaskSwitchKey } = useChatMessages(
        taskState.diracMessages || [],
        taskState.activeVoiceStreamId,
        taskState.isApiRequestActive
    )

    const { isProcessing, setIsProcessing, isExiting, handleCancel, handleExit, clearViewAndResetTask } = useChatTask({
        ctrl,
        taskId,
        initialPrompt,
        initialImages,
        storageKey,
        onExit,
        onError,
        clearState,
        setTextInput,
        setCursorPos,
        setTaskSwitchKey,
    })

    const handleHome = useCallback(() => setCursorPos(0), [setCursorPos])
    const handleEnd = useCallback(() => setCursorPos(textInputRef.current.length), [setCursorPos])

    useHomeEndKeys({
        onHome: handleHome,
        onEnd: handleEnd,
        isActive: !activePanel,
    })

    useRawBackspaceKeys({
        onBackspace: deleteCharsBefore,
        onDelete: deleteCharsAfter,
        isActive: !activePanel,
    })

    useEffect(() => {
        const stored = inputStateStorage.get(storageKey)
        if (stored) {
            setTextInput(stored.text)
            setCursorPos(stored.cursorPos)
            setPastedTexts(stored.pastedTexts)
            pasteCounterRef.current = stored.pasteCounter
        }
    }, [storageKey, setTextInput, setCursorPos])

    useEffect(() => {
        if (textInput || pastedTexts.size > 0) {
            inputStateStorage.set(storageKey, {
                text: textInput,
                cursorPos,
                pastedTexts: new Map(pastedTexts),
                pasteCounter: pasteCounterRef.current,
            })
        }
    }, [storageKey, textInput, cursorPos, pastedTexts])

    useEffect(() => {
        if (taskState.mode && taskState.mode !== mode) {
            setMode(taskState.mode as Mode)
        }
    }, [taskState.mode, mode])

    useEffect(() => {
        if (taskState.yoloModeToggled !== undefined && taskState.yoloModeToggled !== yolo) {
            setYolo(taskState.yoloModeToggled)
        }
    }, [taskState.yoloModeToggled, yolo])

    useEffect(() => {
        if (taskState.autoApproveAllToggled !== undefined && taskState.autoApproveAllToggled !== autoApproveAll) {
            setAutoApproveAll(taskState.autoApproveAllToggled)
        }
    }, [taskState.autoApproveAllToggled, autoApproveAll])

    const toggleAutoApproveAll = useCallback(async () => {
        const newValue = !autoApproveAll
        setAutoApproveAll(newValue)
        StateManager.get().setGlobalState("autoApproveAllToggled", newValue)
        await ctrl?.postStateToWebview()
    }, [autoApproveAll, ctrl])

    const provider = useMemo(() => {
        const providerKey = mode === "act" ? "actModeApiProvider" : "planModeApiProvider"
        const stateManagerValue = StateManager.get().getGlobalSettingsKey(providerKey) as string
        if (stateManagerValue) {
            return stateManagerValue
        }
        const configValue = (taskState.apiConfiguration as any)?.[providerKey] as string | undefined
        if (configValue !== undefined) {
            return configValue
        }
        return (StateManager.get().getGlobalSettingsKey(providerKey) as string) || ""
    }, [mode, taskState.apiConfiguration])

    const modelId = useMemo(() => {
        if (!provider) return ""
        const modelKey = getProviderModelIdKey(provider as ApiProvider, mode)
        const stateManagerValue = StateManager.get().getGlobalSettingsKey(modelKey) as string
        if (stateManagerValue) {
            return stateManagerValue
        }
        const configValue = (taskState.apiConfiguration as any)?.[modelKey] as string | undefined
        if (configValue !== undefined) {
            return configValue
        }
        return (
            (StateManager.get().getGlobalSettingsKey(modelKey) as string) ||
            getProviderDefaultModelId(provider as ApiProvider) ||
            ""
        )
    }, [mode, provider, taskState.apiConfiguration])

    const toggleMode = useCallback(async () => {
        const newMode: Mode = mode === "act" ? "plan" : "act"
        setMode(newMode)
        if (newMode === "act" && textInput.trim()) {
            const expandedText = expandPastedTexts(textInput, pastedTexts)
            await ctrl.togglePlanActMode(newMode, { message: expandedText.trim() })
        } else {
            await ctrl.togglePlanActMode(newMode)
        }
    }, [mode, ctrl, textInput, pastedTexts])

    const refs = useRef({
        searchTimeout: null as NodeJS.Timeout | null,
        lastQuery: "",
        hasCheckedRipgrep: false,
    })

    const { prompt: _prompt, imagePaths } = parseImagesFromInput(textInput)
    const mentionInfo = useMemo(() => extractMentionQuery(textInput), [textInput])
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

    const workspacePath = useMemo(() => {
        try {
            const root = ctrl?.getWorkspaceManagerSync?.()?.getPrimaryRoot?.()
            if (root?.path) return root.path
        } catch { }
        return process.cwd()
    }, [ctrl])

    useEffect(() => {
        setGitBranch(getGitBranch(workspacePath))
        setGitDiffStats(getGitDiffStats(workspacePath))
    }, [workspacePath])

    useEffect(() => {
        const loadCommands = async () => {
            if (!ctrl) return
            try {
                const response = await getAvailableSlashCommands(ctrl, EmptyRequest.create())
                const cliCommands = response.commands.filter((cmd) => cmd.cliCompatible !== false)
                const cliOnlyCommands: SlashCommandInfo[] = CLI_ONLY_COMMANDS.map((cmd) => ({
                    name: cmd.name,
                    description: cmd.description || "",
                    section: cmd.section || "default",
                    cliCompatible: true,
                }))
                setAvailableCommands([...cliOnlyCommands, ...sortCommandsWorkflowsFirst(cliCommands)])
            } catch { }
        }
        loadCommands()
    }, [ctrl])

    const getHistoryItems = useCallback(() => {
        const history = StateManager.get().getGlobalStateKey("taskHistory")
        if (!history?.length) return []
        const filtered = [...history]
            .reverse()
            .map((item) => item.task)
            .slice(0, 20)
            .filter(Boolean) as string[]
        return [...new Set(filtered)]
    }, [])

    const lastMsg = (taskState.diracMessages || [])[(taskState.diracMessages || []).length - 1]
    useEffect(() => {
        setGitDiffStats(getGitDiffStats(workspacePath))
    }, [taskState.diracMessages?.length, taskState.activeVoiceStreamId, lastMsg?.ts, workspacePath])

    const isWelcomeState = displayMessages.length === 0 && !userScrolled

    const staticItems = useMemo(() => {
        const items: Array<
            { key: string; type: "header" } | { key: string; type: "message"; message: (typeof displayMessages)[0] }
        > = []
        if (displayMessages.length > 0 || userScrolled) {
            items.push({ key: "header", type: "header" })
        }
        for (const msg of committedMessages) {
            items.push({ key: msg.id, type: "message", message: msg })
        }
        return items
    }, [committedMessages, displayMessages.length, userScrolled])

    const lastCompletedAsk = useLastCompletedAskMessage()
    const pendingAsk = lastCompletedAsk && respondedToAsk !== lastCompletedAsk.ts ? lastCompletedAsk : null
    const askType = pendingAsk ? getAskPromptType(pendingAsk) : "none"
    const askOptions = pendingAsk && askType === "options" ? parseAskOptions(pendingAsk) : []

    useEffect(() => {
    }, [isProcessing])

    useEffect(() => {
    }, [lastCompletedAsk, respondedToAsk])

    useEffect(() => {
        if (pendingAsk) {
        } else {
        }
    }, [pendingAsk])

    const sendAskResponse = useCallback(
        async (responseType: DiracAskResponse | string, text?: string, value?: string) => {
            if (!ctrl?.task || !pendingAsk) return
            if (!isProcessing) setIsProcessing(true)
            const expandedText = text ? expandPastedTexts(text, pastedTexts) : text
            setRespondedToAsk(pendingAsk.ts)
            setTextInput("")
            setCursorPos(0)
            setPastedTexts(new Map())
            pasteCounterRef.current = 0
            inputStateStorage.delete(storageKey)
            try {
                await ctrl.task.submitCardResponse(pendingAsk.id, responseType, expandedText, undefined, undefined, value)
            } catch (error) {
            } finally {
                setIsProcessing(false)
            }
        },
        [ctrl, pendingAsk, pastedTexts, storageKey, isProcessing, setTextInput, setCursorPos, setIsProcessing],
    )

    const uiActionState = taskState.uiActionState
    const sendingDisabled = uiActionState?.sendingDisabled ?? false

    useEffect(() => {
        if (
            isProcessing &&
            (!uiActionState ||
                (uiActionState.globalButtons.length === 0 && uiActionState.cardButtons.length === 0) ||
                isSpinnerActive)
        ) {
            setIsProcessing(false)
        }
    }, [isProcessing, uiActionState, isSpinnerActive, setIsProcessing])

    const handleButtonAction = useCallback(
        async (action: UIActionButtonType | string | undefined, _isPrimary: boolean = true) => {
            if (!action || !ctrl || isProcessing) return
            setIsProcessing(true)
            try {
                switch (action) {
                    case UIActionButtonType.APPROVE:
                    case UIActionButtonType.RETRY:
                        await sendAskResponse(DiracAskResponse.APPROVE)
                        break
                    case UIActionButtonType.REJECT:
                        if (pendingAsk?.content.type === DiracMessageType.CARD) {
                            const header = pendingAsk.content.card.header.toLowerCase()
                            if (
                                header.includes("resume") ||
                                header.includes("completed") ||
                                header.includes("result") ||
                                header.includes("new task")
                            ) {
                                handleExit()
                            } else {
                                await sendAskResponse(DiracAskResponse.REJECT)
                            }
                        } else {
                            await sendAskResponse(DiracAskResponse.REJECT)
                        }
                        break
                    case UIActionButtonType.PROCEED:
                        await sendAskResponse(DiracAskResponse.APPROVE)
                        break
                    case UIActionButtonType.NEW_TASK:
                        if (
                            pendingAsk?.content.type === DiracMessageType.CARD &&
                            pendingAsk.content.card.header.toLowerCase().includes("new task")
                        ) {
                            setRespondedToAsk(pendingAsk.ts)
                            setTextInput("")
                            setCursorPos(0)
                            await ctrl.initTask(pendingAsk.content.card.body || "")
                        } else {
                            await clearViewAndResetTask()
                        }
                        break
                    case UIActionButtonType.CANCEL:
                        await handleCancel()
                        break
                    default:
                        // For custom actions, we send the value as a message response
                        await sendAskResponse(DiracAskResponse.MESSAGE, undefined, action)
                        break
                }
            } catch (error) {
            } finally {
                setIsProcessing(false)
            }
        },
        [
            ctrl,
            sendAskResponse,
            pendingAsk,
            handleExit,
            handleCancel,
            clearViewAndResetTask,
            isProcessing,
            setIsProcessing,
            setTextInput,
            setCursorPos,
        ],
    )

    const handleAskShortcuts = useCallback(
        (input: string, key: any, currentTextInput: string) => {
            if (!pendingAsk || currentTextInput !== "" || isProcessing) return false
            if (pendingAsk.content.type !== DiracMessageType.CARD) return false
            const { card } = pendingAsk.content

            if (card.requireApproval) {
                if (input.toLowerCase() === "y") {
                    handleButtonAction(DiracAskResponse.APPROVE, true)
                    return true
                }
                if (input.toLowerCase() === "n") {
                    handleButtonAction(DiracAskResponse.REJECT, false)
                    return true
                }
                if (input.toLowerCase() === "a" && !card.header.toLowerCase().includes("command")) {
                    StateManager.get().setSessionOverride("yoloModeToggled", true)
                    handleButtonAction(DiracAskResponse.APPROVE, true)
                    return true
                }
            }

            if (card.requireFeedback) {
                const options = card.actions?.map((a) => a.label) || []
                if (options.length > 0) {
                    const num = Number.parseInt(input, 10)
                    if (!Number.isNaN(num) && num >= 1 && num <= options.length) {
                        sendAskResponse(DiracAskResponse.MESSAGE, options[num - 1])
                        return true
                    }
                }
            }

            const header = card.header.toLowerCase()
            if (header.includes("completed") || header.includes("result")) {
                if (input.toLowerCase() === "q") {
                    handleExit()
                    return true
                }
            }

            return false
        },
        [pendingAsk, isProcessing, handleButtonAction, sendAskResponse, handleExit],
    )

    const handleSubmit = useCallback(
        async (text: string, images: string[]) => {
            if (!ctrl || !text.trim() || isProcessing) return
            if (pendingAsk && pendingAsk.content.type === DiracMessageType.CARD) {
                const prompt = text.trim()
                const normalized = prompt.toLowerCase()
                const { card } = pendingAsk.content
                const header = card.header.toLowerCase()

                if (header.includes("resume") || header.includes("completed") || header.includes("result")) {
                    if (normalized === "q" || normalized === "quit" || normalized === "exit") {
                        handleExit()
                        return
                    }
                    if (!header.includes("completed") && !header.includes("result") && (normalized === "n" || normalized === "no")) {
                        handleExit()
                        return
                    }
                }

                if (card.requireApproval && (normalized === "y" || normalized === "yes")) {
                    await sendAskResponse(DiracAskResponse.APPROVE)
                } else {
                    await sendAskResponse(DiracAskResponse.MESSAGE, prompt)
                }
                setTextInput("")
                setCursorPos(0)
                return
            }
            setIsProcessing(true)
            const expandedText = expandPastedTexts(text, pastedTexts)

            setTextInput("")
            setCursorPos(0)
            setPastedTexts(new Map())
            pasteCounterRef.current = 0
            inputStateStorage.delete(storageKey)
            try {
                const validImages = await processImagePaths(images)
                setTerminalTitle(expandedText.trim())
                await ctrl.initTask(expandedText.trim(), validImages.length > 0 ? validImages : undefined)
            } catch (_error) {
                onError?.()
            } finally {
                setIsProcessing(false)
            }
        },
        [
            ctrl,
            onError,
            pastedTexts,
            storageKey,
            isProcessing,
            setIsProcessing,
            setTextInput,
            setCursorPos,
            pendingAsk,
            handleExit,
            sendAskResponse,
        ],
    )

    useEffect(() => {
        const { current: r } = refs
        if (!mentionInfo.inMentionMode) {
            setFileResults([])
            setSelectedIndex(0)
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
                setTimeout(() => setShowRipgrepWarning(false), 5000)
            }
        }
        const { query } = mentionInfo
        if (query === r.lastQuery) return
        r.lastQuery = query
        if (r.searchTimeout) clearTimeout(r.searchTimeout)
        setIsSearching(true)
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
                    results = await searchWorkspaceFiles(imageQuery, workspacePath, 15, undefined, ["png", "jpg", "jpeg", "gif", "webp"])
                } else {
                    results = await searchWorkspaceFiles(query, workspacePath, 15)
                }
                setFileResults(results)
                setSelectedIndex(0)
            } catch {
                setFileResults([])
            } finally {
                setIsSearching(false)
            }
        }, 150)
        return () => {
            if (r.searchTimeout) clearTimeout(r.searchTimeout)
        }
    }, [mentionInfo.inMentionMode, mentionInfo.query, workspacePath])

    useChatInputHandler({
        textInputRef,
        cursorPosRef,
        setTextInput,
        setCursorPos,
        activePanel,
        setActivePanel,
        handleAskShortcuts,
        handleKeyboardSequence,
        handleCtrlShortcut,
        insertTextAtCursor,
        toggleMode,
        toggleAutoApproveAll,
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
        historyIndex,
        setHistoryIndex,
        savedInput,
        setSavedInput,
        isSpinnerActive,
        isProcessing,
        yolo,
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
        PASTE_COLLAPSE_THRESHOLD: 10000,
        PASTE_CHUNK_WINDOW_MS: 150,
        PASTE_UPDATE_DEBOUNCE_MS: 50,
        mode,
        toggleCardExpansion,
        currentCardId: pendingAsk?.id,
    })

    const borderColor = mode === "act" ? COLORS.primaryBlue : "yellow"
    const metrics = getApiMetrics(taskState.diracMessages || [])
    const lastApiReqTotalTokens = useMemo(() => getLastApiReqTotalTokens(taskState.diracMessages || []), [taskState.diracMessages])
    const contextWindowSize = useMemo(() => {
        const providerData = providerModels[provider]
        if (providerData && modelId in providerData.models) {
            const modelInfo = providerData.models[modelId] as ModelInfo
            if (modelInfo?.contextWindow) return modelInfo.contextWindow
        }
        return 200000
    }, [provider, modelId])

    const showSlashMenu = slashInfo.inSlashMode && !slashMenuDismissed
    const showFileMenu = mentionInfo.inMentionMode && !showSlashMenu

    let inputPrompt = ""
    if (pendingAsk && !yolo && askType === "options" && askOptions.length > 0) {
        inputPrompt = `(1-${askOptions.length} or type)`
    }

    return (
        <Box flexDirection="column" key={taskSwitchKey} width="100%">
            <Static items={staticItems}>
                {(item) => {
                    const card = item.type === "message" && item.message.content.type === DiracMessageType.CARD ? item.message.content.card : null
                    return (
                        <Box key={item.key} paddingX={item.type === "message" ? 1 : 0} width="100%">
                            {item.type === "header" ? (
                                <ChatHeader />
                            ) : (
                                <ChatMessage
                                    message={item.message}
                                    mode={mode}
                                    isExpanded={card ? getIsCardExpanded(card) : false}
                                    onCollapse={card ? () => handleCardCollapse(card.id) : undefined}
                                    activeVoiceStreamId={taskState.activeVoiceStreamId}
                                />
                            )}
                        </Box>
                    )
                }}
            </Static>

            <Box flexDirection="column" width="100%">
                {isWelcomeState && (
                    <ChatHeader
                        isWelcomeState={isWelcomeState}
                        onInteraction={(_input, key) => {
                            if (!key.tab) {
                                setUserScrolled(true)
                            }
                        }}
                        quote={quote}
                    />
                )}

                {liveMessages.map((msg) => {
                    const card = msg.content.type === DiracMessageType.CARD ? msg.content.card : null
                    return (
                        <Box key={msg.id} paddingX={1} width="100%">
                            <ChatMessage
                                isExecuting={msg.ts === respondedToAsk}
                                isStreaming={msg.id === taskState.activeVoiceStreamId}
                                message={msg}
                                mode={mode}
                                isExpanded={card ? getIsCardExpanded(card) : false}
                                onCollapse={card ? () => handleCardCollapse(card.id) : undefined}
                                activeVoiceStreamId={taskState.activeVoiceStreamId}
                            />
                        </Box>
                    )
                })}

                {pendingAsk && !isYoloSuppressed(yolo, pendingAsk) && !isSpinnerActive && (
                    <Box paddingX={1}>
                        <AskPrompt />
                    </Box>
                )}

                {isSpinnerActive && (
                    <ThinkingIndicator mode={mode} onCancel={handleCancel} startTime={spinnerStartTime} />
                )}

                {uiActionState && !activePanel && !isExiting && (
                    <ActionButtons isProcessing={isProcessing} mode={mode} uiActionState={uiActionState} />
                )}

                {!activePanel && !isExiting && (
                    <ChatInputBar
                        availableCommands={availableCommands.map((c) => c.name)}
                        borderColor={borderColor}
                        cursorPos={cursorPos}
                        inputPrompt={inputPrompt}
                        textInput={textInput}
                    />
                )}

                {activePanel?.type === "settings" && (
                    <SettingsPanelContent
                        controller={ctrl}
                        initialMode={activePanel.initialMode}
                        initialModelKey={activePanel.initialModelKey}
                        onClose={() => setActivePanel(null)}
                    />
                )}

                {activePanel?.type === "history" && ctrl && (
                    <HistoryPanelContent
                        controller={ctrl}
                        onClose={() => setActivePanel(null)}
                        onSelectTask={() => setActivePanel(null)}
                    />
                )}

                {activePanel?.type === "help" && <HelpPanelContent onClose={() => setActivePanel(null)} />}

                {activePanel?.type === "skills" && ctrl && (
                    <SkillsPanelContent
                        controller={ctrl}
                        onClose={() => setActivePanel(null)}
                        onUseSkill={(skillPath) => {
                            setActivePanel(null)
                            setTextInput(`@${skillPath} `)
                            setCursorPos(skillPath.length + 2)
                        }}
                    />
                )}

                {showSlashMenu && !activePanel && (
                    <Box paddingLeft={1} paddingRight={1}>
                        <SlashCommandMenu
                            commands={filteredCommands}
                            query={slashInfo.query}
                            selectedIndex={selectedSlashIndex}
                        />
                    </Box>
                )}

                {showFileMenu && !activePanel && (
                    <Box paddingLeft={1} paddingRight={1}>
                        <FileMentionMenu
                            isLoading={isSearching}
                            query={mentionInfo.query}
                            results={fileResults}
                            selectedIndex={selectedIndex}
                            showRipgrepWarning={showRipgrepWarning}
                        />
                    </Box>
                )}

                {imagePaths.length > 0 && !activePanel && (
                    <Box paddingLeft={1} paddingRight={1}>
                        <Text color="magenta">
                            {imagePaths.length} image{imagePaths.length > 1 ? "s" : ""} attached
                        </Text>
                    </Box>
                )}

                {!showSlashMenu && !showFileMenu && !activePanel && (
                    <ChatFooter
                        autoApproveAll={autoApproveAll}
                        contextWindowSize={contextWindowSize}
                        gitBranch={gitBranch}
                        gitDiffStats={gitDiffStats}
                        lastApiReqTotalTokens={lastApiReqTotalTokens}
                        mode={mode}
                        modelId={modelId}
                        provider={provider}
                        totalCost={metrics.totalCost}
                        taskStatus={taskState.taskStatus}
                        workspacePath={workspacePath}
                    />
                )}
            </Box>

            {imagePaths.length > 0 && !activePanel && (
                <Box
                    {...({
                        position: "absolute",
                        width: stdout?.columns || 80,
                        height: stdout?.rows || 24,
                        flexDirection: "column",
                        justifyContent: "flex-end",
                        alignItems: "flex-end",
                        paddingRight: 2,
                        paddingBottom: 1,
                    } as any)}>
                    <Box flexDirection="column" alignItems="flex-end">
                        <Box borderStyle="round" borderColor="magenta">
                            <Image
                                key={imagePaths[imagePaths.length - 1]}
                                src={path.resolve(imagePaths[imagePaths.length - 1])}
                                width={30}
                            />
                        </Box>
                        <Text color="gray" dimColor>
                            {path.basename(imagePaths[imagePaths.length - 1])}
                        </Text>
                    </Box>
                </Box>
            )}
        </Box>
    )
}
