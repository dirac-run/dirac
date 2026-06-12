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


import { DiracMessageType, TaskStatus, UIActionButtonType, isFinalStatus } from "@shared/ExtensionMessage"
import { DiracAskResponse } from "@shared/WebviewMessage"
import { getRandomQuote } from "@/shared/quotes"
import type { Mode } from "@shared/storage/types"
import { Box, Static, Text, useStdout } from "ink"
import path from "node:path"
import Image from "ink-picture"
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { StateManager } from "@/core/storage/StateManager"
import { COLORS } from "../constants/colors"
import { useTaskContext, useTaskState } from "../context/TaskContext"
import { useIsSpinnerActive } from "../hooks/useStateSubscriber"
import { useTerminalSize } from "../hooks/useTerminalSize"
import { setTerminalTitle } from "../utils/display"
import { processImagePaths } from "../utils/parser"
import { ActionButtons } from "./ActionButtons"

import { AskPrompt } from "./AskPrompt"
import { ChatMessage } from "./ChatMessage"
import { FileMentionMenu } from "./FileMentionMenu"
import { HelpPanelContent } from "./HelpPanelContent"
import { HistoryPanelContent } from "./HistoryPanelContent"
import { SettingsPanelContent } from "./SettingsPanelContent"
import { SkillsPanelContent } from "./SkillsPanelContent"
import { PermissionModal } from "./PermissionModal"
import { SlashCommandMenu } from "./SlashCommandMenu"
import { ThinkingIndicator } from "./ThinkingIndicator"
import { ChatFooter } from "./ChatFooter"
import { ChatHeader } from "./ChatHeader"
import { ChatInputBar } from "./ChatInputBar"
import { useComposer, type ActivePanel, type ComposerActions } from "../hooks/useComposer"
import { useChatTimeline } from "../hooks/useChatTimeline"
import { useChatFooterStatus } from "../hooks/useChatFooterStatus"
import { useChatTask } from "../hooks/useChatTask"
import { expandPastedTexts, getAskPromptType, isYoloSuppressed, parseAskOptions } from "../utils/chat"
import { calculateChatLayoutRows } from "../utils/chat-layout"
import { estimateVisualLineCount } from "../utils/text-clipping"

interface ChatViewProps {
    controller?: any
    onExit?: () => void
    onComplete?: () => void
    onError?: () => void
    initialPrompt?: string
    initialImages?: string[]
    taskId?: string
}


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
    const { columns: terminalColumns, rows: terminalRows } = useTerminalSize()
    const taskState = useTaskState()
    const { controller: taskController, clearState } = useTaskContext()
    const { isActive: isSpinnerActive, startTime: spinnerStartTime } = useIsSpinnerActive()
    const ctrl = useMemo(() => controller || taskController, [controller, taskController])

    const resetComposerInputRef = useRef<() => void>(() => { })
    const composerActionsRef = useRef<ComposerActions>({
        handleAskShortcuts: () => false,
        handleSubmit: () => { },
        handleExit: () => { },
        clearViewAndResetTask: () => { },
        handleButtonAction: () => { },
        toggleMode: () => { },
        toggleAutoApproveAll: () => { },
        toggleTranscriptVerbosity: () => { },
    })

    const [respondedToAsk, setRespondedToAsk] = useState<string | null>(null)
    const [userScrolled, setUserScrolled] = useState(false)
    const [cardExpansions, setCardExpansions] = useState<Map<string, "auto" | "expanded" | "collapsed">>(new Map())
    const [isVerboseTranscript, setIsVerboseTranscript] = useState(false)

    const handleCardCollapse = useCallback((cardId: string) => {
        setCardExpansions((prev) => {
            const next = new Map(prev)
            next.set(cardId, "collapsed")
            return next
        })
    }, [])

    const getIsCardExpanded = (card: { id: string; collapsed?: boolean; body?: string }): boolean => {
        const expansion = cardExpansions.get(card.id)
        if (expansion === "expanded") return true
        if (expansion === "collapsed") return false
        if (card.collapsed === false) return true
        if (isVerboseTranscript && card.body) return true
        return false
    }

    const [activePanel, setActivePanel] = useState<ActivePanel>(null)

    const [mode, setMode] = useState<Mode>(() => {
        const stateManager = StateManager.get()
        return stateManager.getGlobalSettingsKey("mode") || "act"
    })

    const [yolo, setYolo] = useState<boolean>(() => StateManager.get().getGlobalSettingsKey("yoloModeToggled") ?? false)
    const [autoApproveAll, setAutoApproveAll] = useState<boolean>(
        () => StateManager.get().getGlobalSettingsKey("autoApproveAllToggled") ?? false,
    )

    const { displayMessages, staticItems, dynamicItems, taskSwitchKey, setTaskSwitchKey } = useChatTimeline({
        messages: taskState.diracMessages || [],
        activeVoiceStreamId: taskState.activeVoiceStreamId,
        isApiRequestActive: taskState.isApiRequestActive,
        taskStatus: taskState.taskStatus,
        showHeader:
            (taskState.diracMessages || []).some((message) => message.content?.type !== DiracMessageType.API_STATUS) ||
            userScrolled,
        layoutRows: calculateChatLayoutRows({
            terminalRows,
            hasConversationContent: true,
            hasActivity: taskState.isApiRequestActive === true,
            hasComposer: true,
            hasFooter: true,
            hasPanel: false,
        }),
    })

    const { isProcessing, setIsProcessing, isExiting, handleCancel, handleExit, clearViewAndResetTask } = useChatTask({
        ctrl,
        taskId,
        initialPrompt,
        initialImages,
        resetComposerInput: () => resetComposerInputRef.current(),
        onExit,
        onError,
        clearState,
        setTaskSwitchKey,
    })

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

    const footerStatus = useChatFooterStatus({
        ctrl,
        mode,
        taskState,
    })

    const isEmptyConversation = displayMessages.length === 0
    const isWelcomeState = isEmptyConversation && !userScrolled

    const activeCardId = taskState.uiActionState?.activeCardId
    const pendingAsk = useMemo(() => {
        if (!activeCardId || activeCardId === respondedToAsk) return null
        return (taskState.diracMessages || []).find(
            (message) => message.id === activeCardId && message.content.type === DiracMessageType.CARD,
        ) || null
    }, [activeCardId, respondedToAsk, taskState.diracMessages])
    useEffect(() => {
        if (respondedToAsk && respondedToAsk !== activeCardId) {
            setRespondedToAsk(null)
        }
    }, [activeCardId, respondedToAsk])
    const askType = pendingAsk ? getAskPromptType(pendingAsk) : "none"
    const askOptions = pendingAsk && askType === "options" ? parseAskOptions(pendingAsk) : []

    const permissionCard = pendingAsk?.content.type === DiracMessageType.CARD
        && !isYoloSuppressed(yolo, pendingAsk)
        && !isSpinnerActive
        && !isFinalStatus(pendingAsk.content.card.status)
        && (pendingAsk.content.card.requireApproval || pendingAsk.content.card.requireFeedback)
        ? pendingAsk.content.card
        : null
    const permissionModalWidth = Math.max(1, Math.min(terminalColumns - 2, Math.floor(terminalColumns * 0.8)))
    const permissionModalHeight = Math.min(Math.max(12, terminalRows - 4), 32)
    const permissionModalBodyLines = Math.max(1, permissionModalHeight - 7)
    const permissionModalBodyColumns = Math.max(1, permissionModalWidth - 6)

    // Permission modal scroll state — offset from the bottom of the pending card body.
    const [cardScrollOffset, setCardScrollOffset] = useState(0)

    const scrollableCardMaxOffset = useMemo(() => {
        if (!permissionCard?.body) return 0
        const totalLines = estimateVisualLineCount(permissionCard.body, permissionModalBodyColumns)
        return Math.max(0, totalLines - permissionModalBodyLines)
    }, [permissionCard, permissionModalBodyColumns, permissionModalBodyLines])


    // Reset scroll offset when pending ask changes
    useEffect(() => { setCardScrollOffset(0) }, [pendingAsk?.id])

    const {
        textInput,
        cursorPos,
        setTextInput,
        setCursorPos,
        pastedTexts,
        resetInput,
        availableCommands,
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
        imagePaths,
    } = useComposer({
        ctrl,
        taskId,
        mode,
        workspacePath: footerStatus.workspacePath,
        activePanel,
        setActivePanel,
        isSpinnerActive,
        isProcessing,
        uiActionState: taskState.uiActionState,
        yolo,
        pendingAsk,
        actionsRef: composerActionsRef,
        isYoloSuppressed,
        isEmptyConversation,
        scrollableCardMaxOffset,
        cardScrollOffset,
        setCardScrollOffset,
    })
    resetComposerInputRef.current = resetInput

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


    const sendAskResponse = useCallback(
        async (responseType: DiracAskResponse | string, text?: string, value?: string) => {
            if (!ctrl?.task || !pendingAsk) return
            if (!isProcessing) setIsProcessing(true)
            const expandedText = text ? expandPastedTexts(text, pastedTexts) : text
            setRespondedToAsk(pendingAsk.id)
            resetInput()
            try {
                await ctrl.task.submitCardResponse(pendingAsk.id, responseType, expandedText, undefined, undefined, value)
            } catch (error) {
            } finally {
                setIsProcessing(false)
            }
        },
        [ctrl, pendingAsk, pastedTexts, isProcessing, setIsProcessing, resetInput],
    )

    const submitResumeResponse = useCallback(
        async (responseType: DiracAskResponse, text?: string, images?: string[]) => {
            if (!ctrl?.task) return
            const expandedText = text ? expandPastedTexts(text, pastedTexts) : text
            await ctrl.task.submitCardResponse("", responseType, expandedText, images)
            resetInput()
        },
        [ctrl, pastedTexts, resetInput],
    )

    const uiActionState = taskState.uiActionState
    const sendingDisabled = uiActionState?.sendingDisabled ?? false

    const hasGlobalAction = useCallback(
        (action: UIActionButtonType) => uiActionState?.globalButtons.some((button) => button.action === action) ?? false,
        [uiActionState],
    )
    const isCompletionChoiceActive = taskState.taskStatus === TaskStatus.COMPLETED || hasGlobalAction(UIActionButtonType.NEW_TASK)
    const isResumeChoiceActive = taskState.taskStatus === TaskStatus.CANCELLED
    const submitResumeTextResponse = useCallback(
        async (text: string, images: string[]) => {
            if (!isResumeChoiceActive) return false
            const trimmedText = text.trim()
            const normalizedText = trimmedText.toLowerCase()
            if (normalizedText === "q" || normalizedText === "quit" || normalizedText === "exit") {
                handleExit()
                return true
            }
            await submitResumeResponse(DiracAskResponse.MESSAGE, trimmedText, images)
            return true
        },
        [isResumeChoiceActive, submitResumeResponse, handleExit],
    )

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
                        if (isResumeChoiceActive) {
                            await submitResumeResponse(DiracAskResponse.APPROVE)
                        } else {
                            await sendAskResponse(DiracAskResponse.APPROVE)
                        }
                        break
                    case UIActionButtonType.REJECT:
                        if (isCompletionChoiceActive || isResumeChoiceActive) {
                            handleExit()
                        } else {
                            await sendAskResponse(DiracAskResponse.REJECT)
                        }
                        break
                    case UIActionButtonType.PROCEED:
                        if (isResumeChoiceActive) {
                            await submitResumeResponse(DiracAskResponse.APPROVE)
                        } else {
                            await sendAskResponse(DiracAskResponse.APPROVE)
                        }
                        break
                    case UIActionButtonType.NEW_TASK:
                        await clearViewAndResetTask()
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
            submitResumeResponse,
            handleExit,
            handleCancel,
            clearViewAndResetTask,
            isProcessing,
            setIsProcessing,
            isCompletionChoiceActive,
            isResumeChoiceActive,
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

            if (isCompletionChoiceActive && input.toLowerCase() === "q") {
                handleExit()
                return true
            }

            return false
        },
        [pendingAsk, isProcessing, handleButtonAction, sendAskResponse, handleExit, isCompletionChoiceActive],
    )

    const handleSubmit = useCallback(
        async (text: string, images: string[]) => {
            if (!ctrl || !text.trim() || isProcessing) return
            if (await submitResumeTextResponse(text, images)) return
            if (pendingAsk && pendingAsk.content.type === DiracMessageType.CARD) {
                const prompt = text.trim()
                const normalized = prompt.toLowerCase()
                const { card } = pendingAsk.content

                if (isCompletionChoiceActive || isResumeChoiceActive) {
                    if (normalized === "q" || normalized === "quit" || normalized === "exit") {
                        handleExit()
                        return
                    }
                    if (isResumeChoiceActive && (normalized === "n" || normalized === "no")) {
                        handleExit()
                        return
                    }
                }

                if (card.requireApproval && (normalized === "y" || normalized === "yes")) {
                    await sendAskResponse(DiracAskResponse.APPROVE)
                } else {
                    await sendAskResponse(DiracAskResponse.MESSAGE, prompt)
                }
                resetInput()
                return
            }
            setIsProcessing(true)
            const expandedText = expandPastedTexts(text, pastedTexts)

            resetInput()
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
        [ctrl, onError, pastedTexts, isProcessing, setIsProcessing, pendingAsk, handleExit, sendAskResponse, submitResumeTextResponse, resetInput, isCompletionChoiceActive, isResumeChoiceActive],
    )

    const borderColor = mode === "act" ? COLORS.primaryBlue : "yellow"
    let inputPrompt = ""
    if (pendingAsk && !yolo && askType === "options" && askOptions.length > 0) {
        inputPrompt = `(1-${askOptions.length} or type)`
    } else if (isResumeChoiceActive) {
        inputPrompt = "(type to resume)"
    }

    composerActionsRef.current = {
        handleAskShortcuts,
        handleSubmit,
        handleExit,
        clearViewAndResetTask,
        handleButtonAction,
        toggleMode,
        toggleAutoApproveAll,
        toggleTranscriptVerbosity: () => setIsVerboseTranscript((verbose) => !verbose),
    }

    const shouldShowAskPrompt = pendingAsk && !permissionCard && !isYoloSuppressed(yolo, pendingAsk) && !isSpinnerActive
    const shouldShowActionButtons = uiActionState && !permissionCard && !activePanel && !isExiting
    const shouldShowComposerInput = !activePanel && !isExiting
    const shouldShowFooter = !showSlashMenu && !showFileMenu && !activePanel

    const renderTurnBoundary = (key: string) => (
        <Box key={key} paddingX={1}>
            <Text color="gray" dimColor>{"─".repeat(Math.max(1, Math.min(48, terminalColumns - 4)))}</Text>
        </Box>
    )

    const shouldSuppressCardBody = (card: { requireApproval?: boolean; requireFeedback?: boolean } | null): boolean => {
        return card ? Boolean(card.requireApproval || card.requireFeedback) : false
    }



    const renderDynamicItem = (item: (typeof dynamicItems)[number]) => {
        if (item.type === "notice") {
            return (
                <Box key={item.key} paddingX={1}>
                    <Text color="gray" dimColor>{item.message}</Text>
                </Box>
            )
        }
        if (item.type === "boundary") {
            return renderTurnBoundary(item.key)
        }


        const msg = item.message
        const card = msg.content.type === DiracMessageType.CARD ? msg.content.card : null
        return (
            <React.Fragment key={item.key}>
                <ChatMessage
                    isExecuting={msg.id === respondedToAsk}
                    isStreaming={msg.id === taskState.activeVoiceStreamId}
                    message={msg}
                    mode={mode}
                    isExpanded={card ? getIsCardExpanded(card) : false}
                    onCollapse={card ? () => handleCardCollapse(card.id) : undefined}
                    activeVoiceStreamId={taskState.activeVoiceStreamId}
                    showReasoning={true}
                    compact={item.isCompact}
                    maxContentLines={item.maxContentLines}
                    suppressCardBody={shouldSuppressCardBody(card)}
                />
            </React.Fragment>
        )
    }

    const dynamicItemsContent = (
        <React.Fragment>
            {dynamicItems.map(renderDynamicItem)}
        </React.Fragment>
    )

    const activityContent = (
        <React.Fragment>
            {shouldShowAskPrompt && (
                <Box paddingX={1}>
                    <AskPrompt />
                </Box>
            )}

            {isSpinnerActive && (
                <ThinkingIndicator
                    mode={mode}
                    onCancel={handleCancel}
                    startTime={spinnerStartTime}
                    lastAction={(() => {
                        const msgs = taskState.diracMessages ?? []
                        for (let i = msgs.length - 1; i >= 0; i--) {
                            const m = msgs[i]
                            if (m.content.type === "card" && m.content.card.endTime) {
                                return m.content.card.header
                            }
                        }
                        return undefined
                    })()}
                />
            )}

            {shouldShowActionButtons && (
                <ActionButtons isProcessing={isProcessing} mode={mode} uiActionState={uiActionState} />
            )}
        </React.Fragment>
    )

    const liveViewportContent = (
        <Box key="live-viewport"
            flexDirection="column"
            overflow="hidden"
            width="100%">
            {dynamicItemsContent}
            {activityContent}
        </Box>
    )

    const permissionViewportContent = permissionCard ? (
        <Box key={`permission-${permissionCard.id}`} alignItems="center" flexDirection="column" flexGrow={1} justifyContent="center" width="100%">
            <PermissionModal
                bodyColumns={permissionModalBodyColumns}
                bodyLines={permissionModalBodyLines}
                card={permissionCard}
                maxScrollOffset={scrollableCardMaxOffset}
                scrollOffset={cardScrollOffset}
            />
        </Box>
    ) : liveViewportContent

    const composerFooterContent = (
        <React.Fragment>
            {shouldShowComposerInput && (
                <ChatInputBar
                    availableCommands={availableCommands.map((c) => c.name)}
                    borderColor={borderColor}
                    cursorPos={cursorPos}
                    inputPrompt={inputPrompt}
                    textInput={textInput}
                    terminalColumns={terminalColumns}
                    terminalRows={terminalRows}
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

            {imagePaths.length > 0 && !activePanel && !permissionCard && (
                <Box paddingLeft={1} paddingRight={1}>
                    <Text color="magenta">
                        {imagePaths.length} image{imagePaths.length > 1 ? "s" : ""} attached
                    </Text>
                </Box>
            )}

            {shouldShowFooter && (
                <ChatFooter
                    autoApproveAll={autoApproveAll}
                    contextWindowSize={footerStatus.contextWindowSize}
                    gitBranch={footerStatus.gitBranch}
                    gitDiffStats={footerStatus.gitDiffStats}
                    lastApiReqTotalTokens={footerStatus.lastApiReqTotalTokens}
                    mode={mode}
                    modelId={footerStatus.modelId}
                    provider={footerStatus.provider}
                    totalCost={footerStatus.totalCost}
                    taskStatus={footerStatus.taskStatus}
                    workspacePath={footerStatus.workspacePath}
                />
            )}
        </React.Fragment>
    )

    return (
        <Box flexDirection="column" key={taskSwitchKey} width="100%">
            <Static items={staticItems}>
                {(item) => {
                    if (item.type === "header") {
                        return (
                            <Box key={item.key} paddingX={0} width="100%">
                                <ChatHeader />
                            </Box>
                        )
                    }
                    if (item.type === "boundary") {
                        return renderTurnBoundary(item.key)
                    }

                    const card = item.message.content.type === DiracMessageType.CARD ? item.message.content.card : null
                    return (
                        <Box key={item.key} paddingX={1} width="100%">
                            <ChatMessage
                                message={item.message}
                                mode={mode}
                                isExpanded={card ? getIsCardExpanded(card) : false}
                                onCollapse={card ? () => handleCardCollapse(card.id) : undefined}
                                activeVoiceStreamId={taskState.activeVoiceStreamId}
                                showReasoning={true}
                                suppressCardBody={shouldSuppressCardBody(card)}
                            />
                        </Box>
                    )
                }}
            </Static>

            <Box flexDirection="column" width="100%"
                flexGrow={1}
                {...(isEmptyConversation
                    ? { maxHeight: Math.max(1, terminalRows - 6) }
                    : {})}>
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

                {isEmptyConversation ? (
                    <Box flexDirection="column">
                        {permissionCard ? permissionViewportContent : (
                            <React.Fragment>
                                {dynamicItemsContent}
                                <Box flexGrow={1} />
                                {activityContent}
                            </React.Fragment>
                        )}
                        {composerFooterContent}
                    </Box>
                ) : (
                    <Box flexDirection="column" flexGrow={1}>
                        <Box flexGrow={1} />
                        {permissionViewportContent}
                        {composerFooterContent}
                    </Box>
                )}

            </Box>

            {imagePaths.length > 0 && !activePanel && !permissionCard && (
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
