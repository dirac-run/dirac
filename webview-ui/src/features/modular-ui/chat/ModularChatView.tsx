import { Mode } from "@shared/ExtensionMessage"
import React, { useEffect, useMemo } from "react"
import { useMount } from "react-use"
import { useAppStore } from "@/app/store/appStore"
import { useShowNavbar } from "@/context/PlatformContext"
import { useTaskStore } from "@/entities/task/store/taskStore"
import { useChatStore } from "@/features/chat/store/chatStore"
import { normalizeApiConfiguration } from "@/features/settings/components/utils/providerUtils"
import { useSettingsStore } from "@/features/settings/store/settingsStore"
import { cn } from "@/lib/utils"
import { Navbar } from "@/shared/ui/Navbar"
import { ChatLayout } from "./components/ChatLayout"
import { ApprovalTray } from "./components/ApprovalTray"
import { InteractionState, useInteractionState } from "./context/InteractionStateContext"
// Decorators
import { ActionButtonsDecorator } from "./decorators/view/ActionButtonsDecorator"
import { AutoApproveDecorator } from "./decorators/view/AutoApproveDecorator"
import { useChatState } from "./hooks/useChatState"
import { useMessageHandlers } from "./hooks/useMessageHandlers"
import { useScrollBehavior } from "./hooks/useScrollBehavior"
import { GoalSection } from "./sections/GoalSection"
// Sections
import { InputSection } from "./sections/InputSection"
import { MessagesSection } from "./sections/MessagesSection"
import { TaskSection } from "./sections/TaskSection"
import { WelcomeSection } from "./sections/WelcomeSection"
import { ChatSection, ChatViewContext, ChatViewDecorator, ChatViewProps } from "./types"
import { useShallow } from "zustand/react/shallow"

export const ModularChatView: React.FC<ChatViewProps> = ({ isHidden, showAnnouncement, hideAnnouncement, showHistoryView }) => {
	const showNavbar = useShowNavbar()
	const version = useAppStore((state) => state.version)
	const { messages, task, renderedMessageIds, apiMetrics, lastApiReqInfo } = useChatStore(
		useShallow((state) => ({
			messages: state.diracMessages,
			task: state.taskMessage,
			renderedMessageIds: state.visibleMessageIds,
			apiMetrics: state.apiMetrics,
			lastApiReqInfo: state.lastApiReqInfo,
		})),
	)
	const goal = useChatStore((state) => state.goal)
	const taskHistory = useTaskStore((state) => state.taskHistory)
	const apiConfiguration = useSettingsStore((state) => state.apiConfiguration)
	const telemetrySetting = useSettingsStore((state) => state.telemetrySetting)
	const mode = useSettingsStore((state) => state.mode)
	const effectiveMode = goal?.mode ?? mode
	const shouldShowQuickWins = !!taskHistory && taskHistory.length > 0

	const chatState = useChatState()
	const { sendingDisabled, uiActionState, expandedRows, setExpandedRows, textAreaRef } = chatState

	const messageHandlers = useMessageHandlers(chatState)

	const { state: interactionState } = useInteractionState()
	const { selectedModelInfo, selectedModelId, selectedProvider } = useMemo(() => {
		return normalizeApiConfiguration(apiConfiguration, effectiveMode as Mode)
	}, [apiConfiguration, effectiveMode])

	useMount(() => {
		textAreaRef.current?.focus()
	})

	const hasButtons = (uiActionState?.globalButtons.length ?? 0) > 0 || (uiActionState?.cardButtons.length ?? 0) > 0
	useEffect(() => {
		const timer = setTimeout(() => {
			if (!isHidden && !sendingDisabled && !hasButtons && document.hasFocus()) {
				textAreaRef.current?.focus()
			}
		}, 50)
		return () => {
			clearTimeout(timer)
		}
	}, [isHidden, sendingDisabled, hasButtons, textAreaRef])

	const scrollBehavior = useScrollBehavior(messages, renderedMessageIds, renderedMessageIds, expandedRows, setExpandedRows)

	const placeholderText = useMemo(() => {
		if (goal?.followUpActive) return "Steer this follow-up…"
		if (goal?.status === "working") return "Steer this Goal…"
		if (goal?.status === "waiting") return "Steer this Goal while requests await a response…"
		if (goal?.status === "paused") return "Ask a follow-up (Goal stays paused)…"
		if (goal?.status === "blocked") return "Ask a follow-up (Goal stays blocked)…"
		if (goal?.status === "achieved" || goal?.status === "stopped") return "Ask a follow-up…"
		if (!task) return "Type your task here..."
		if (interactionState === InteractionState.RUNNING) return "Send guidance for the next turn without interrupting…"
		return "Type a message..."
	}, [goal, task, interactionState])

	const context = useMemo<ChatViewContext>(
		() => ({
			goal,
			task,
			renderedMessageIds,
			apiMetrics,
			lastApiReqInfo,
			chatState,
			messageHandlers,
			scrollBehavior,
			isHidden,
			showAnnouncement,
			hideAnnouncement,
			showHistoryView,
			version,
			taskHistory,
			shouldShowQuickWins,
			telemetrySetting,
			selectedModelInfo: {
				...selectedModelInfo,
				selectedModelId,
				selectedProvider,
				mode: effectiveMode,
			},
			placeholderText,
		}),
		[
			goal,
			task,
			renderedMessageIds,
			apiMetrics,
			lastApiReqInfo,
			chatState,
			messageHandlers,
			scrollBehavior,
			isHidden,
			showAnnouncement,
			hideAnnouncement,
			showHistoryView,
			version,
			taskHistory,
			shouldShowQuickWins,
			telemetrySetting,
			selectedModelInfo,
			selectedModelId,
			selectedProvider,
			effectiveMode,
			placeholderText,
		],
	)

	const sections = useMemo<ChatSection[]>(() => [WelcomeSection, GoalSection, TaskSection, MessagesSection, InputSection], [])

	const decorators = useMemo<ChatViewDecorator[]>(() => [AutoApproveDecorator, ActionButtonsDecorator], [])

	return (
		<ChatLayout isHidden={isHidden}>
			<div className="modular-chat-shell flex flex-col flex-1 overflow-hidden relative">
				<div
					className={cn(
						"modular-chat-shell flex flex-col flex-1 overflow-hidden",
						effectiveMode === "plan" ? "bg-grid-plan" : "",
					)}>
					{showNavbar && <Navbar />}
					<div className="flex-1 min-h-0 flex flex-col overflow-hidden relative">
						{sections.map((section) => (
							<React.Fragment key={section.id}>
								{section.id !== "input" && section.shouldRender(context) && section.render(context)}
							</React.Fragment>
						))}
					</div>

					<div className="flex flex-col gap-2">
						{decorators.map((decorator) => (
							<React.Fragment key={decorator.id}>{decorator.render?.(context)}</React.Fragment>
						))}
					</div>

					<ApprovalTray messageHandlers={messageHandlers} />

					<div className="px-4">{InputSection.shouldRender(context) && InputSection.render(context)}</div>
				</div>
			</div>
		</ChatLayout>
	)
}
