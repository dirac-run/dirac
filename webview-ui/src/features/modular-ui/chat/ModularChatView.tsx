import React, { useCallback, useEffect, useMemo } from "react"
import { useMount } from "react-use"
import { ChatViewProps, ChatViewContext, ChatSection, ChatViewDecorator } from "./types"
import { useChatStore } from "@/features/chat/store/chatStore"
import { useTaskStore } from "@/entities/task/store/taskStore"
import { useSettingsStore } from "@/features/settings/store/settingsStore"
import { useAppStore } from "@/app/store/appStore"
import { useUserStore } from "@/entities/user/store/userStore"
import { useShowNavbar } from "@/context/PlatformContext"
import { normalizeApiConfiguration } from "@/features/settings/components/utils/providerUtils"
import { Mode } from "@shared/ExtensionMessage"
import { getApiMetrics, getLastApiReqInfo } from "@shared/getApiMetrics"
import { combineCardSequences } from "@shared/combineCardSequences"
import { useChatState } from "./hooks/useChatState"
import { useMessageHandlers } from "./hooks/useMessageHandlers"
import { useScrollBehavior } from "./hooks/useScrollBehavior"
import { filterVisibleMessages, groupLowStakesTools, groupMessages } from "./utils/messageUtils"
import { ChatLayout } from "./components/ChatLayout"
import { CHAT_CONSTANTS } from "./constants"
import { Navbar } from "@/shared/ui/Navbar"
import { cn } from "@/lib/utils"
import { FileServiceClient } from "@/shared/api/grpc-client"
import { BooleanRequest } from "@shared/proto/dirac/common"

// Sections
import { WelcomeSection } from "./sections/WelcomeSection"
import { TaskSection } from "./sections/TaskSection"
import { MessagesSection } from "./sections/MessagesSection"
import { InputSection } from "./sections/InputSection"

// Decorators
import { AutoApproveDecorator } from "./decorators/view/AutoApproveDecorator"
import { ActionButtonsDecorator } from "./decorators/view/ActionButtonsDecorator"

import { useDebouncedValue } from "@/shared/lib/useDebouncedValue"
const MAX_IMAGES_AND_FILES_PER_MESSAGE = CHAT_CONSTANTS.MAX_IMAGES_AND_FILES_PER_MESSAGE
const QUICK_WINS_HISTORY_THRESHOLD = 3

export const ModularChatView: React.FC<ChatViewProps> = ({
    isHidden,
    showAnnouncement,
    hideAnnouncement,
    showHistoryView,
}) => {
    const showNavbar = useShowNavbar()
    const hydrate = useChatStore((state) => state.hydrate)
    const version = useAppStore((state: any) => state.version)
    const { diracMessages: messages, activeVoiceStreamId, isApiRequestActive } = useChatStore()
    const taskHistory = useTaskStore((state) => state.taskHistory)
    const apiConfiguration = useSettingsStore((state: any) => state.apiConfiguration)
    const telemetrySetting = useSettingsStore((state) => state.telemetrySetting)
    const mode = useSettingsStore((state) => state.mode)
    const userInfo = useUserStore((state) => state.userInfo)
    const isProdHostedApp = (userInfo as any)?.appBaseUrl === "https://app.dirac.run"
    const shouldShowQuickWins = !!taskHistory && taskHistory.length > 0

    const task = useMemo(() => messages.at(0), [messages])
    const streamingActive = isApiRequestActive || !!activeVoiceStreamId
    const debouncedMessages = useDebouncedValue(messages, streamingActive ? 150 : 0)

    const modifiedMessages = useMemo(() => {
        const slicedMessages = debouncedMessages.slice(1)
        return combineCardSequences(slicedMessages)
    }, [debouncedMessages])

    const apiMetrics = useMemo(() => getApiMetrics(modifiedMessages), [modifiedMessages])
    const lastApiReqInfo = useMemo(() => getLastApiReqInfo(modifiedMessages), [modifiedMessages])

    const chatState = useChatState(messages)
    const {
        setInputValue,
        selectedImages,
        setSelectedImages,
        selectedFiles,
        setSelectedFiles,
        sendingDisabled,
        uiActionState,
        expandedRows,
        setExpandedRows,
        textAreaRef,
    } = chatState

    const messageHandlers = useMessageHandlers(messages, chatState)

    const { selectedModelInfo, selectedModelId, selectedProvider } = useMemo(() => {
        return normalizeApiConfiguration(apiConfiguration, mode as Mode)
    }, [apiConfiguration, mode])

    const selectFilesAndImages = useCallback(async () => {
        try {
            const response = await FileServiceClient.selectFiles(
                BooleanRequest.create({
                    value: selectedModelInfo.supportsImages,
                })
            )
            if (
                response &&
                response.values1 &&
                response.values2 &&
                (response.values1.length > 0 || response.values2.length > 0)
            ) {
                const currentTotal = selectedImages.length + selectedFiles.length
                const availableSlots = MAX_IMAGES_AND_FILES_PER_MESSAGE - currentTotal

                if (availableSlots > 0) {
                    const imagesToAdd = Math.min(response.values1.length, availableSlots)
                    if (imagesToAdd > 0) {
                        setSelectedImages((prevImages) => [...prevImages, ...response.values1.slice(0, imagesToAdd)])
                    }

                    const remainingSlots = availableSlots - imagesToAdd
                    if (remainingSlots > 0) {
                        setSelectedFiles((prevFiles) => [...prevFiles, ...response.values2.slice(0, remainingSlots)])
                    }
                }
            }
        } catch (error) {
            console.error("Error selecting images & files:", error)
        }
    }, [selectedModelInfo.supportsImages, selectedImages.length, selectedFiles.length, setSelectedImages, setSelectedFiles])

    const shouldDisableFilesAndImages = selectedImages.length + selectedFiles.length >= MAX_IMAGES_AND_FILES_PER_MESSAGE

    useEffect(() => {
        const cleanup = hydrate()
        return cleanup
    }, [hydrate])

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

    const visibleMessages = useMemo(() => {
        return filterVisibleMessages(modifiedMessages)
    }, [modifiedMessages])

    const groupedMessages = useMemo(() => {
        return groupLowStakesTools(groupMessages(visibleMessages))
    }, [visibleMessages])

    const scrollBehavior = useScrollBehavior(messages, visibleMessages, groupedMessages, expandedRows, setExpandedRows)

    const placeholderText = useMemo(() => {
        return task ? "Type a message..." : "Type your task here..."
    }, [task])

    const context = useMemo<ChatViewContext>(
        () => ({
            task,
            messages,
            modifiedMessages,
            groupedMessages,
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
                mode,
            },
            shouldDisableFilesAndImages,
            selectFilesAndImages,
            placeholderText,
        }),
        [
            task,
            messages,
            modifiedMessages,
            groupedMessages,
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
            mode,
            shouldDisableFilesAndImages,
            selectFilesAndImages,
            placeholderText,
        ]
    )

    const sections = useMemo<ChatSection[]>(
        () => [WelcomeSection, TaskSection, MessagesSection, InputSection],
        []
    )

    const decorators = useMemo<ChatViewDecorator[]>(
        () => [AutoApproveDecorator, ActionButtonsDecorator],
        []
    )

    return (
        <ChatLayout isHidden={isHidden}>
            <div className="flex flex-col flex-1 overflow-hidden relative">
                <div className={cn("flex flex-col flex-1 overflow-hidden", mode === "plan" ? "bg-grid-plan" : "")}>
                    {showNavbar && <Navbar />}
                    <div className="flex-1 flex flex-col overflow-hidden relative">
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

                    <div className="px-4 pb-4">
                        {InputSection.shouldRender(context) && InputSection.render(context)}
                    </div>
                </div>
            </div>
        </ChatLayout>
    )
}
