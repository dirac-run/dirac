import { theme } from "../constants/theme"
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
 * 2. Static Transcript + Bounded Live Tail:
 *    We use Ink's <Static> component for an append-only transcript prefix and keep
 *    a row-budgeted rolling suffix in a fixed-height live viewport. Finalized items
 *    enter terminal scrollback only after all of their rows leave the live window.
 *    Oversized output is rendered through a bounded, scrollable window.
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
import { modelSupportsInferenceSpeed, type ApiProvider } from "@shared/api"
import type { Settings } from "@shared/storage/state-keys"
import { DiracAskResponse } from "@shared/WebviewMessage"
import { getRandomQuote } from "@/shared/quotes"
import type { Mode } from "@shared/storage/types"
import { Box, Static, Text, useStdout } from "ink"
import path from "node:path"
import Image from "ink-picture"
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { StateManager } from "@/core/storage/StateManager"
import { Logger } from "@/shared/services/Logger"
import { useTaskContext, useTaskState } from "../context/TaskContext"
import { useIsSpinnerActive } from "../hooks/useStateSubscriber"
import { useTerminalSize } from "../hooks/useTerminalSize"
import { setTerminalTitle } from "../utils/display"
import { processImagePaths } from "../utils/parser"
import { ActionButtons } from "./ActionButtons"

import { ChatMessage } from "./ChatMessage"
import { FileMentionMenu } from "./FileMentionMenu"
import { HelpPanelContent } from "./HelpPanelContent"
import { HistoryPanelContent } from "./HistoryPanelContent"
import { SettingsPanelContent } from "./SettingsPanelContent"
import { SkillsPanelContent } from "./SkillsPanelContent"
import { OpenAiCodexUsagePanel } from "./OpenAiCodexUsagePanel"
import { AgentPanelContent } from "./AgentPanelContent"
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
import {
	calculateChatLayoutRows,
	calculateGoalSummaryRows,
	calculatePermissionModalLayout,
	shouldShowGoalFooter,
} from "../utils/chat-layout"
import { estimateVisualLineCount } from "../utils/text-clipping"
import { cardBodyForDisplay } from "../utils/card-body"
import { createCardBodySuppressionPolicy } from "../utils/quiet-mode"
import { clearTaskDeadline, getTaskDeadline, hasTaskTimedOut, markTaskTimedOut } from "../utils/task-timeout"
import { CliPanelType } from "../types"
import { GoalSummary } from "./GoalSummary"
import { type GoalLifecycleAction, isRunningGoalStatus } from "../utils/goals"

const GOAL_STOP_CONFIRMATION_MS = 5_000
interface ChatViewProps {
	controller?: any
	onExit?: () => void
	onComplete?: () => void
	onError?: () => void
	initialPrompt?: string
	initialImages?: string[]
	taskId?: string
	timeoutSeconds?: number
	verbose?: boolean
}

export const ChatView: React.FC<ChatViewProps> = ({
	controller,
	onExit,
	onComplete: _onComplete,
	onError,
	initialPrompt,
	initialImages,
	taskId,
	timeoutSeconds,
}) => {
	const quote = useMemo(() => getRandomQuote(), [])
	const { stdout } = useStdout()
	const { columns: terminalColumns, rows: terminalRows } = useTerminalSize()
	const taskState = useTaskState()
	const { controller: taskController, clearState, lastError, setLastError } = useTaskContext()
	const { isActive: isSpinnerActive, startTime: spinnerStartTime } = useIsSpinnerActive()
	const ctrl = useMemo(() => controller || taskController, [controller, taskController])

	const resetComposerInputRef = useRef<() => void>(() => {})
	const composerActionsRef = useRef<ComposerActions>({
		handleAskShortcuts: () => false,
		handleSubmit: () => {},
		handleExit: () => {},
		clearViewAndResetTask: () => {},
		handleButtonAction: () => {},
		toggleMode: () => {},
		toggleAutoApproveAll: () => {},
		enableFastMode: () => {},
		toggleQuietMode: () => {},
	})

	const [respondedToAsk, setRespondedToAsk] = useState<string | null>(null)
	const [userScrolled, setUserScrolled] = useState(false)
	const [activePanel, setActivePanel] = useState<ActivePanel>(null)

	const [mode, setMode] = useState<Mode>(() => {
		const stateManager = StateManager.get()
		return stateManager.getGlobalSettingsKey("mode") || "act"
	})

	const [yolo, setYolo] = useState<boolean>(() => StateManager.get().getGlobalSettingsKey("yoloModeToggled") ?? false)
	const [autoApproveAll, setAutoApproveAll] = useState<boolean>(
		() => StateManager.get().getGlobalSettingsKey("autoApproveAllToggled") ?? false,
	)
	const [quietMode, setQuietMode] = useState(false)
	const quietModeRef = useRef(false)
	const shouldSuppressCardBody = useMemo(() => createCardBodySuppressionPolicy(() => quietModeRef.current), [])

	const [timelineScrollOffset, setTimelineScrollOffset] = useState(0)
	const [pendingGoalStopId, setPendingGoalStopId] = useState<string | undefined>()
	const pendingGoalStopIdRef = useRef<string | undefined>(undefined)
	const pendingGoalStopTimeoutRef = useRef<NodeJS.Timeout | undefined>(undefined)
	const [goalDetailsExpanded, setGoalDetailsExpanded] = useState(false)
	const selectedGoal = taskState.goal
	const goalSummaryRows = selectedGoal ? calculateGoalSummaryRows(terminalRows, goalDetailsExpanded) : 0
	const goalFooterVisible = !selectedGoal || shouldShowGoalFooter(terminalRows)

	const layoutRows = calculateChatLayoutRows({
		terminalRows,
		hasConversationContent: true,
		hasComposer: activePanel === null,
		hasFooter: activePanel === null && goalFooterVisible,
		hasPanel: activePanel !== null,
		footerRows: selectedGoal ? 2 : undefined,
		goalSummaryRows: activePanel === null ? goalSummaryRows : 0,
	})

	const {
		displayMessages,
		staticItems,
		dynamicItems,
		dynamicScrollMessageId,
		dynamicScrollMaxOffset,
		taskSwitchKey,
		setTaskSwitchKey,
	} = useChatTimeline({
		messages: taskState.diracMessages || [],
		activeVoiceStreamId: taskState.activeVoiceStreamId,
		isApiRequestActive: taskState.isApiRequestActive,
		taskStatus: taskState.taskStatus,
		showHeader:
			(taskState.diracMessages || []).some((message) => message.content?.type !== DiracMessageType.API_STATUS) ||
			userScrolled,
		layoutRows,
		terminalColumns,
		scrollOffset: timelineScrollOffset,
		shouldSuppressCardBody,
	})

	useEffect(() => {
		setTimelineScrollOffset(0)
	}, [dynamicScrollMessageId])

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

	const toggleQuietMode = useCallback(() => {
		setQuietMode((current) => {
			const next = !current
			quietModeRef.current = next
			return next
		})
	}, [])

	const footerStatus = useChatFooterStatus({
		ctrl,
		mode,
		taskState,
	})

	const reportInteractionError = useCallback(
		(context: string, error: unknown) => {
			const message = error instanceof Error ? error.message : String(error)
			Logger.error(`${context}:`, error)
			setLastError(`${context}: ${message}`)
			onError?.()
		},
		[onError, setLastError],
	)

	const enableFastMode = useCallback(async () => {
		const provider = footerStatus.provider as ApiProvider
		const modelId = footerStatus.modelId
		if (!provider || !modelId || !modelSupportsInferenceSpeed(provider, modelId)) {
			setLastError(
				`No Fast Mode configuration is available for the current provider/model (${provider || "unconfigured"}:${modelId || "unconfigured"}).`,
			)
			return
		}

		setLastError(null)
		const stateManager = StateManager.get()
		const targetModes = taskState.planActSeparateModelsSetting ? [mode] : (["plan", "act"] as const)
		const settings: Partial<Settings> = {}
		for (const targetMode of targetModes) {
			const speedKey = targetMode === "act" ? "actModeInferenceSpeed" : "planModeInferenceSpeed"
			settings[speedKey] = "fast"
		}
		const installSessionOverrides = () => {
			for (const targetMode of targetModes) {
				const speedKey = targetMode === "act" ? "actModeInferenceSpeed" : "planModeInferenceSpeed"
				stateManager.setSessionOverride(speedKey, "fast")
			}
		}

		try {
			if (ctrl?.task) await ctrl.task.applyWorkingConfigurationUpdate({ settings }, installSessionOverrides)
			else installSessionOverrides()
			await ctrl?.postStateToWebview()
		} catch (error) {
			reportInteractionError("Failed to enable Fast Mode", error)
		}
	}, [
		ctrl,
		footerStatus.modelId,
		footerStatus.provider,
		mode,
		reportInteractionError,
		setLastError,
		taskState.planActSeparateModelsSetting,
	])

	const { isProcessing, setIsProcessing, isExiting, handleCancel, handleExit, clearViewAndResetTask } = useChatTask({
		ctrl,
		taskId,
		initialPrompt,
		initialImages,
		resetComposerInput: () => resetComposerInputRef.current(),
		onExit,
		onError,
		onInteractionError: reportInteractionError,
		clearState,
		setTaskSwitchKey,
	})

	const disarmGoalStopConfirmation = useCallback(() => {
		if (pendingGoalStopTimeoutRef.current) clearTimeout(pendingGoalStopTimeoutRef.current)
		pendingGoalStopTimeoutRef.current = undefined
		pendingGoalStopIdRef.current = undefined
		setPendingGoalStopId(undefined)
	}, [])

	const toggleGoalDetails = useCallback(() => {
		disarmGoalStopConfirmation()
		setGoalDetailsExpanded((expanded) => !expanded)
	}, [disarmGoalStopConfirmation])

	useEffect(() => {
		disarmGoalStopConfirmation()
	}, [disarmGoalStopConfirmation, selectedGoal?.id, selectedGoal?.status])

	useEffect(() => {
		setGoalDetailsExpanded(false)
	}, [selectedGoal?.id])

	useEffect(() => disarmGoalStopConfirmation, [disarmGoalStopConfirmation])

	useEffect(() => {
		if (activePanel) disarmGoalStopConfirmation()
	}, [activePanel, disarmGoalStopConfirmation])

	const handleGoalControl = useCallback(
		async (action: GoalLifecycleAction) => {
			const goal = taskState.goal
			if (!goal || !ctrl || isProcessing) return
			if (action === "stop" && pendingGoalStopIdRef.current !== goal.id) {
				disarmGoalStopConfirmation()
				pendingGoalStopIdRef.current = goal.id
				setPendingGoalStopId(goal.id)
				pendingGoalStopTimeoutRef.current = setTimeout(() => {
					pendingGoalStopIdRef.current = undefined
					pendingGoalStopTimeoutRef.current = undefined
					setPendingGoalStopId(undefined)
				}, GOAL_STOP_CONFIRMATION_MS)
				return
			}

			disarmGoalStopConfirmation()
			setIsProcessing(true)
			setLastError(null)
			try {
				if (action === "pause") {
					await ctrl.pauseGoal(goal.id, "Paused from the interactive CLI")
				} else if (action === "resume") {
					await ctrl.resumeGoal(goal.id)
				} else {
					await ctrl.stopGoal(goal.id, "Stopped from the interactive CLI")
				}
			} catch (error) {
				reportInteractionError(`Failed to ${action} Goal`, error)
			} finally {
				setIsProcessing(false)
			}
		},
		[ctrl, disarmGoalStopConfirmation, isProcessing, reportInteractionError, setIsProcessing, setLastError, taskState.goal],
	)

	const activeTaskId = ctrl?.task?.taskId
	const isTaskActive =
		taskState.taskStatus !== TaskStatus.IDLE &&
		taskState.taskStatus !== TaskStatus.COMPLETED &&
		taskState.taskStatus !== TaskStatus.CANCELLED
	useEffect(() => {
		if (!timeoutSeconds || !activeTaskId || selectedGoal) return
		if (!isTaskActive) {
			clearTaskDeadline(activeTaskId)
			return
		}
		if (hasTaskTimedOut(activeTaskId)) return

		const deadline = getTaskDeadline(activeTaskId, timeoutSeconds)
		const remainingMs = Math.max(0, deadline - Date.now())
		const timeout = setTimeout(() => {
			markTaskTimedOut(activeTaskId)
			const timeoutError = new Error(`Task timed out after ${timeoutSeconds} seconds.`)
			reportInteractionError("Task timeout", timeoutError)
			ctrl.task?.abortTask().catch((error: unknown) => reportInteractionError("Failed to cancel timed-out task", error))
		}, remainingMs)
		return () => clearTimeout(timeout)
	}, [activeTaskId, ctrl, isTaskActive, reportInteractionError, selectedGoal, timeoutSeconds])

	const isEmptyConversation = displayMessages.length === 0
	const isWelcomeState = isEmptyConversation && !userScrolled && activePanel === null

	const activeCardId = taskState.uiActionState?.activeCardId
	const pendingAsk = useMemo(() => {
		if (!activeCardId || activeCardId === respondedToAsk) return null
		return (
			(taskState.diracMessages || []).find(
				(message) =>
					message.id === activeCardId &&
					message.content.type === DiracMessageType.CARD &&
					!isFinalStatus(message.content.card.status),
			) || null
		)
	}, [activeCardId, respondedToAsk, taskState.diracMessages])
	useEffect(() => {
		if (respondedToAsk && respondedToAsk !== activeCardId) {
			setRespondedToAsk(null)
		}
	}, [activeCardId, respondedToAsk])
	const askType = pendingAsk ? getAskPromptType(pendingAsk) : "none"
	const askOptions = pendingAsk && askType === "options" ? parseAskOptions(pendingAsk) : []

	const permissionCard =
		pendingAsk?.content.type === DiracMessageType.CARD &&
		!isYoloSuppressed(yolo, pendingAsk) &&
		!isSpinnerActive &&
		!isFinalStatus(pendingAsk.content.card.status) &&
		(pendingAsk.content.card.requireApproval || pendingAsk.content.card.requireFeedback)
			? pendingAsk.content.card
			: null
	const permissionModalLayout = calculatePermissionModalLayout(terminalColumns, terminalRows)

	// Permission modal scroll state — offset from the bottom of the pending card body.
	const [permissionCardScrollOffset, setPermissionCardScrollOffset] = useState(0)

	const scrollableCardMaxOffset = useMemo(() => {
		if (!permissionCard) return 0
		const body = cardBodyForDisplay(permissionCard.body, permissionCard.renderType)
		if (!body) return 0
		const totalLines = estimateVisualLineCount(body, permissionModalLayout.bodyColumns)
		return Math.max(0, totalLines - permissionModalLayout.bodyLines)
	}, [permissionCard, permissionModalLayout.bodyColumns, permissionModalLayout.bodyLines])

	// Reset scroll offset when pending ask changes
	useEffect(() => {
		setPermissionCardScrollOffset(0)
	}, [pendingAsk?.id])

	const activeScrollableMaxOffset = permissionCard ? scrollableCardMaxOffset : dynamicScrollMaxOffset
	const activeScrollOffset = permissionCard ? permissionCardScrollOffset : timelineScrollOffset
	const setActiveScrollOffset = useCallback(
		(offset: number) => {
			if (permissionCard) {
				setPermissionCardScrollOffset(offset)
				return
			}
			setTimelineScrollOffset(offset)
		},
		[permissionCard],
	)

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
		fileSearchError,
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
		scrollableCardMaxOffset: activeScrollableMaxOffset,
		cardScrollOffset: activeScrollOffset,
		setCardScrollOffset: setActiveScrollOffset,
		goalStatus: selectedGoal?.status,
		handleGoalControl,
		toggleGoalDetails,
		disarmGoalStopConfirmation,
	})
	resetComposerInputRef.current = resetInput

	const toggleMode = useCallback(async () => {
		if (selectedGoal) {
			setLastError(selectedGoal.modeSwitchingExplanation)
			return
		}
		const newMode: Mode = mode === "act" ? "plan" : "act"
		setMode(newMode)
		if (newMode === "act" && textInput.trim()) {
			const expandedText = expandPastedTexts(textInput, pastedTexts)
			await ctrl.togglePlanActMode(newMode, { message: expandedText.trim() })
		} else {
			await ctrl.togglePlanActMode(newMode)
		}
	}, [mode, ctrl, textInput, pastedTexts, selectedGoal, setLastError])

	const sendAskResponse = useCallback(
		async (responseType: DiracAskResponse | string, text?: string, value?: string, images?: string[]) => {
			if (!ctrl?.task || !pendingAsk) return false
			if (!isProcessing) setIsProcessing(true)
			const expandedText = text ? expandPastedTexts(text, pastedTexts) : text
			setLastError(null)
			try {
				await ctrl.task.submitCardResponse(pendingAsk.id, responseType, expandedText, images, undefined, value)
				setRespondedToAsk(pendingAsk.id)
				resetInput()
				return true
			} catch (error) {
				reportInteractionError("Failed to send response", error)
				return false
			} finally {
				setIsProcessing(false)
			}
		},
		[ctrl, pendingAsk, pastedTexts, isProcessing, setIsProcessing, resetInput, setLastError, reportInteractionError],
	)

	const submitResumeResponse = useCallback(
		async (responseType: DiracAskResponse, text?: string, images?: string[]) => {
			if (!ctrl?.task) return
			const expandedText = text ? expandPastedTexts(text, pastedTexts) : text
			setLastError(null)
			const task = await ctrl.prepareTaskForFollowUp()
			await task.submitCardResponse("", responseType, expandedText, images)
			resetInput()
		},
		[ctrl, pastedTexts, resetInput, setLastError],
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
			if (!isResumeChoiceActive && !isCompletionChoiceActive) return false
			const trimmedText = text.trim()
			const normalizedText = trimmedText.toLowerCase()
			if (normalizedText === "q" || normalizedText === "quit" || normalizedText === "exit") {
				handleExit()
				return true
			}
			setIsProcessing(true)
			try {
				const validImages = images.length > 0 ? await processImagePaths(images, footerStatus.workspacePath) : undefined
				await submitResumeResponse(DiracAskResponse.MESSAGE, trimmedText, validImages)
				return true
			} finally {
				setIsProcessing(false)
			}
		},
		[
			isResumeChoiceActive,
			isCompletionChoiceActive,
			submitResumeResponse,
			handleExit,
			footerStatus.workspacePath,
			setIsProcessing,
		],
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
		async (action: UIActionButtonType | string | undefined, _isPrimary: boolean = true, value?: string) => {
			if (!action || !ctrl || isProcessing) return
			setIsProcessing(true)
			setLastError(null)
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
					default: {
						const expandedText = textInput.trim() ? expandPastedTexts(textInput, pastedTexts).trim() : undefined
						const validImages =
							imagePaths.length > 0 ? await processImagePaths(imagePaths, footerStatus.workspacePath) : undefined
						await sendAskResponse(DiracAskResponse.APPROVE, expandedText, value ?? action, validImages)
						break
					}
				}
			} catch (error) {
				reportInteractionError("Failed to perform action", error)
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
			textInput,
			pastedTexts,
			imagePaths,
			footerStatus.workspacePath,
			setLastError,
			reportInteractionError,
		],
	)

	const handleAskShortcuts = useCallback(
		(input: string, key: any, currentTextInput: string) => {
			if (!pendingAsk || currentTextInput !== "" || isProcessing) return false
			if (pendingAsk.content.type !== DiracMessageType.CARD) return false
			const { card } = pendingAsk.content

			if (card.requireApproval && (!card.actions || card.actions.length === 0)) {
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
						handleButtonAction(UIActionButtonType.UTILITY, false, card.actions![num - 1].value)
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
		[pendingAsk, isProcessing, handleButtonAction, handleExit, isCompletionChoiceActive],
	)

	const handleSubmit = useCallback(
		async (text: string, images: string[]) => {
			if (!ctrl || (!text.trim() && images.length === 0) || isProcessing) return
			setLastError(null)
			const goal = taskState.goal
			const isGoalPassthrough =
				pendingAsk?.content.type === DiracMessageType.CARD &&
				pendingAsk.content.card.toolName === "resolve_task_interaction"
			if (goal && (!pendingAsk || isGoalPassthrough)) {
				if (images.length > 0) {
					setLastError("Goal messages currently accept text only.")
					return
				}
				setIsProcessing(true)
				try {
					const expandedText = expandPastedTexts(text, pastedTexts).trim()
					await ctrl.sendGoalMessage(goal.id, expandedText)
					resetInput()
				} catch (error) {
					reportInteractionError("Failed to send Goal message", error)
				} finally {
					setIsProcessing(false)
				}
				return
			}
			try {
				if (await submitResumeTextResponse(text, images)) return
			} catch (error) {
				reportInteractionError("Failed to resume task", error)
				return
			}
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

				if (
					card.requireApproval &&
					(!card.actions || card.actions.length === 0) &&
					(normalized === "y" || normalized === "yes")
				) {
					await sendAskResponse(DiracAskResponse.APPROVE)
				} else {
					const validImages =
						images.length > 0 ? await processImagePaths(images, footerStatus.workspacePath) : undefined
					await sendAskResponse(DiracAskResponse.MESSAGE, prompt, undefined, validImages)
				}
				return
			}
			setIsProcessing(true)
			const expandedText = expandPastedTexts(text, pastedTexts)

			try {
				const validImages = await processImagePaths(images, footerStatus.workspacePath)
				setTerminalTitle(expandedText.trim())
				if (ctrl.task) {
					const task = await ctrl.prepareTaskForFollowUp()
					await task.submitCardResponse(
						"",
						DiracAskResponse.MESSAGE,
						expandedText.trim(),
						validImages.length > 0 ? validImages : undefined,
					)
				} else {
					await ctrl.initTask(expandedText.trim(), validImages.length > 0 ? validImages : undefined)
				}
				resetInput()
			} catch (_error) {
				reportInteractionError("Failed to send message", _error)
			} finally {
				setIsProcessing(false)
			}
		},
		[
			ctrl,
			pastedTexts,
			isProcessing,
			setIsProcessing,
			pendingAsk,
			handleExit,
			sendAskResponse,
			submitResumeTextResponse,
			resetInput,
			isCompletionChoiceActive,
			isResumeChoiceActive,
			setLastError,
			reportInteractionError,
			footerStatus.workspacePath,
			taskState.goal,
		],
	)

	const borderColor = mode === "act" ? theme.primary : theme.plan
	let inputPrompt = ""
	if (selectedGoal?.followUpActive) {
		inputPrompt = "(steer follow-up)"
	} else if (isRunningGoalStatus(selectedGoal?.status)) {
		inputPrompt = "(steer Goal)"
	} else if (selectedGoal) {
		inputPrompt = "(follow up Goal)"
	} else if (pendingAsk && !yolo && askType === "options" && askOptions.length > 0) {
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
		enableFastMode,
		toggleAutoApproveAll,
		toggleQuietMode,
	}

	const shouldShowActionButtons = uiActionState && !permissionCard && !activePanel && !isExiting
	const shouldShowComposerInput = !activePanel && !isExiting
	const shouldShowFooter = !activePanel && goalFooterVisible

	const renderTurnBoundary = (key: string) => (
		<Box key={key} paddingX={1}>
			<Text color={theme.muted} dimColor>
				{"─".repeat(Math.max(1, Math.min(48, terminalColumns - 4)))}
			</Text>
		</Box>
	)

	const renderDynamicItem = (item: (typeof dynamicItems)[number]) => {
		if (item.type === "notice") {
			return (
				<Box key={item.key} paddingX={1}>
					<Text color={theme.muted} dimColor>
						{item.message}
					</Text>
				</Box>
			)
		}
		if (item.type === "boundary") {
			return renderTurnBoundary(item.key)
		}

		const msg = item.message
		return (
			<React.Fragment key={item.key}>
				<ChatMessage
					isExecuting={msg.id === respondedToAsk}
					isStreaming={msg.id === taskState.activeVoiceStreamId}
					message={msg}
					mode={mode}
					activeVoiceStreamId={taskState.activeVoiceStreamId}
					showReasoning={true}
					compact={item.isCompact}
					tailOnly={item.tailOnly}
					maxContentLines={item.maxContentLines}
					scrollOffset={item.scrollOffset}
					suppressCardBody={shouldSuppressCardBody(msg)}
				/>
			</React.Fragment>
		)
	}

	const dynamicItemsContent = <React.Fragment>{dynamicItems.map(renderDynamicItem)}</React.Fragment>

	const activityContent = (
		<React.Fragment>
			{isSpinnerActive && (
				<ThinkingIndicator
					isActive={!activePanel}
					mode={mode}
					onCancel={handleCancel}
					startTime={spinnerStartTime}
					lastAction={(() => {
						const msgs = taskState.diracMessages ?? []
						for (let i = msgs.length - 1; i >= 0; i--) {
							const m = msgs[i]
							if (m.content.type === DiracMessageType.CARD && m.content.card.endTime) {
								return m.content.card.header
							}
						}
						return undefined
					})()}
				/>
			)}

			{shouldShowActionButtons && <ActionButtons isProcessing={isProcessing} mode={mode} uiActionState={uiActionState} />}
		</React.Fragment>
	)

	const liveViewportContent = (
		<Box
			key="live-viewport"
			flexDirection="column"
			flexShrink={0}
			height={layoutRows.liveViewportRows}
			justifyContent="flex-start"
			overflow="hidden"
			width="100%">
			{dynamicItemsContent}
			{activityContent}
		</Box>
	)

	const permissionViewportContent = permissionCard ? (
		<Box
			key={`permission-${permissionCard.id}`}
			alignItems="center"
			flexDirection="column"
			flexGrow={1}
			justifyContent="center"
			width="100%">
			<PermissionModal
				bodyColumns={permissionModalLayout.bodyColumns}
				bodyLines={permissionModalLayout.bodyLines}
				card={permissionCard}
				height={permissionModalLayout.height}
				maxScrollOffset={scrollableCardMaxOffset}
				scrollOffset={permissionCardScrollOffset}
				width={permissionModalLayout.width}
			/>
		</Box>
	) : (
		liveViewportContent
	)

	const composerFooterContent = (
		<React.Fragment>
			{selectedGoal && !activePanel && (
				<GoalSummary
					detailsExpanded={goalDetailsExpanded}
					goal={selectedGoal}
					height={goalSummaryRows}
					isProcessing={isProcessing}
					isStopConfirmationPending={pendingGoalStopId === selectedGoal.id}
					onPageNavigation={disarmGoalStopConfirmation}
				/>
			)}
			{lastError && !activePanel && (
				<Box paddingLeft={1} paddingRight={1}>
					<Text color={theme.error}>! {lastError}</Text>
				</Box>
			)}

			{activePanel?.type === CliPanelType.SETTINGS && (
				<SettingsPanelContent
					controller={ctrl}
					initialMode={activePanel.initialMode}
					initialModelKey={activePanel.initialModelKey}
					onClose={() => setActivePanel(null)}
				/>
			)}

			{activePanel?.type === CliPanelType.HISTORY && ctrl && (
				<HistoryPanelContent
					controller={ctrl}
					onClose={() => setActivePanel(null)}
					onSelectTask={() => setActivePanel(null)}
				/>
			)}

			{activePanel?.type === CliPanelType.HELP && <HelpPanelContent onClose={() => setActivePanel(null)} />}

			{activePanel?.type === CliPanelType.SKILLS && ctrl && (
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

			{activePanel?.type === CliPanelType.USAGE && (
				<OpenAiCodexUsagePanel
					controller={ctrl}
					isAuthenticated={taskState.openAiCodexIsAuthenticated === true}
					onClose={() => setActivePanel(null)}
					snapshot={taskState.openAiCodexUsage}
				/>
			)}

			{activePanel?.type === CliPanelType.AGENTS && (
				<AgentPanelContent
					messages={taskState.diracMessages ?? []}
					availableRows={Math.max(1, terminalRows - layoutRows.liveViewportRows)}
					onClose={() => setActivePanel(null)}
					taskStatus={taskState.taskStatus}
				/>
			)}

			{imagePaths.length > 0 && !activePanel && !permissionCard && (
				<Box paddingLeft={1} paddingRight={1}>
					<Text color={theme.magenta}>
						{imagePaths.length} image{imagePaths.length > 1 ? "s" : ""} attached
					</Text>
				</Box>
			)}
			{showSlashMenu && !activePanel && (
				<Box paddingLeft={1} paddingRight={1}>
					<SlashCommandMenu commands={filteredCommands} query={slashInfo.query} selectedIndex={selectedSlashIndex} />
				</Box>
			)}

			{showFileMenu && !activePanel && (
				<Box paddingLeft={1} paddingRight={1}>
					<FileMentionMenu
						error={fileSearchError}
						isLoading={isSearching}
						query={mentionInfo.query}
						results={fileResults}
						selectedIndex={selectedIndex}
						showRipgrepWarning={showRipgrepWarning}
					/>
				</Box>
			)}

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

			{shouldShowFooter && (
				<ChatFooter
					autoApproveAll={autoApproveAll}
					yoloMode={yolo}
					quietMode={quietMode}
					contextWindowSize={footerStatus.contextWindowSize}
					gitBranch={footerStatus.gitBranch}
					gitDiffStats={footerStatus.gitDiffStats}
					lastApiReqTotalTokens={footerStatus.lastApiReqTotalTokens}
					mode={mode}
					modelId={footerStatus.modelId}
					fastModeEnabled={footerStatus.fastModeEnabled}
					isGoalActive={selectedGoal !== undefined}
					provider={footerStatus.provider}
					totalCost={footerStatus.totalCost}
					cacheHitRate={footerStatus.cacheHitRate}
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
								<ChatHeader quote={quote} />
							</Box>
						)
					}
					if (item.type === "boundary") {
						return renderTurnBoundary(item.key)
					}

					return (
						<Box key={item.key} paddingX={1} width="100%">
							<ChatMessage
								message={item.message}
								mode={mode}
								activeVoiceStreamId={taskState.activeVoiceStreamId}
								showReasoning={true}
								reasoningDisplay={quietMode ? "tail" : "full"}
								suppressCardBody={shouldSuppressCardBody(item.message)}
							/>
						</Box>
					)
				}}
			</Static>

			<Box
				flexDirection="column"
				width="100%"
				flexGrow={1}
				{...(isEmptyConversation ? { maxHeight: Math.max(1, terminalRows - 6) } : {})}>
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
						{permissionCard ? (
							permissionViewportContent
						) : (
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
						<Box borderStyle="round" borderColor={theme.magenta}>
							<Image
								key={imagePaths[imagePaths.length - 1]}
								src={path.resolve(imagePaths[imagePaths.length - 1])}
								width={30}
							/>
						</Box>
						<Text color={theme.muted} dimColor>
							{path.basename(imagePaths[imagePaths.length - 1])}
						</Text>
					</Box>
				</Box>
			)}
		</Box>
	)
}
