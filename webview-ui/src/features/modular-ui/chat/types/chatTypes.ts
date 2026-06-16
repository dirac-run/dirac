/**
 * Shared types and interfaces for the chat view components
 */

import { DiracMessage, TaskStatus, UIActionState } from "@shared/ExtensionMessage"
import { ListRange, VirtuosoHandle } from "react-virtuoso"
import { ButtonActionType } from "../utils/buttonConfig"

/**
 * Main ChatView component props
 */
export interface ChatViewProps {
    isHidden: boolean
    showAnnouncement: boolean
    hideAnnouncement: () => void
    showHistoryView: () => void
}

/**
 * Chat state interface
 */
export interface ChatState {
    // State values
    inputValue: string
    setInputValue: React.Dispatch<React.SetStateAction<string>>
    activeQuote: string | null
    setActiveQuote: React.Dispatch<React.SetStateAction<string | null>>
    isTextAreaFocused: boolean
    setIsTextAreaFocused: React.Dispatch<React.SetStateAction<boolean>>
    selectedImages: string[]
    setSelectedImages: React.Dispatch<React.SetStateAction<string[]>>
    selectedFiles: string[]
    setSelectedFiles: React.Dispatch<React.SetStateAction<string[]>>
    sendingDisabled: boolean
    setSendingDisabled: React.Dispatch<React.SetStateAction<boolean>>
    expandedRows: Record<string, boolean>
    setExpandedRows: React.Dispatch<React.SetStateAction<Record<string, boolean>>>

    // Refs
    textAreaRef: React.RefObject<HTMLTextAreaElement>

    // Derived values
    lastMessage: DiracMessage | undefined
    secondLastMessage: DiracMessage | undefined
    task: DiracMessage | undefined

    // Handlers
    handleFocusChange: (isFocused: boolean) => void
    clearExpandedRows: () => void
    resetState: () => void

    uiActionState?: UIActionState
    activeVoiceStreamId?: string
    isApiRequestActive?: boolean
    taskStatus?: TaskStatus

    // Scroll-related state (will be moved to scroll hook)
    showScrollToBottom?: boolean
    isAtBottom?: boolean
    pendingScrollToMessage?: number | null
}

/**
 * Message handlers interface
 */
export interface MessageHandlers {
    executeButtonAction: (
        action: ButtonActionType,
        value?: string,
        text?: string,
        images?: string[],
        files?: string[],
        cardId?: string,
    ) => Promise<void>
    handleSendMessage: (text: string, images: string[], files: string[]) => Promise<void>
    handleTaskCloseButtonClick: () => void
    startNewTask: () => Promise<void>
}

/**
 * Scroll behavior interface
 */
export interface ScrollBehavior {
    virtuosoRef: React.RefObject<VirtuosoHandle>
    footerRef: React.RefObject<HTMLDivElement>
    disableAutoScrollRef: React.MutableRefObject<boolean>
    scrollToBottomSmooth: () => void
    scrollToBottomAuto: () => void
    scrollToBottomNow: () => void
    scrollToMessage: (messageIndex: number) => void
    toggleRowExpansion: (id: string) => void
    programmaticScrollRef: React.MutableRefObject<boolean>
    showScrollToBottom: boolean
    setShowScrollToBottom: React.Dispatch<React.SetStateAction<boolean>>
    isAtBottom: boolean
    isAtBottomRef: React.MutableRefObject<boolean>
    setIsAtBottom: React.Dispatch<React.SetStateAction<boolean>>
    pendingScrollToMessage: number | null
    setPendingScrollToMessage: React.Dispatch<React.SetStateAction<number | null>>
    handleRangeChanged: (range: ListRange) => void
}

/**
 * Button state interface
 */
export interface ButtonState {
    enableButtons: boolean
    primaryButtonText: string | undefined
    secondaryButtonText: string | undefined
}

/**
 * Input state interface
 */
export interface InputState {
    inputValue: string
    selectedImages: string[]
    selectedFiles: string[]
    activeQuote: string | null
    isTextAreaFocused: boolean
}

/**
 * Task section props
 */
export interface TaskSectionProps {
    task: DiracMessage
    messages: DiracMessage[]
    scrollBehavior: ScrollBehavior
    buttonState: ButtonState
    messageHandlers: MessageHandlers
    chatState: ChatState
    apiMetrics: {
        totalTokensIn: number
        totalTokensOut: number
        totalCacheWrites?: number
        totalCacheReads?: number
        totalCost: number
    }
    lastApiReqTotalTokens?: number
    selectedModelInfo: {
        supportsPromptCache: boolean
        supportsImages: boolean
    }
    isStreaming: boolean
    modifiedMessages: DiracMessage[]
}

/**
 * Welcome section props
 */
export interface WelcomeSectionProps {
    showAnnouncement: boolean
    hideAnnouncement: () => void
    showHistoryView: () => void
    telemetrySetting: string
    version: string
    taskHistory: any[]
    shouldShowQuickWins: boolean
}

/**
 * Input section props
 */
export interface InputSectionProps {
    chatState: ChatState
    messageHandlers: MessageHandlers
    textAreaRef: React.RefObject<HTMLTextAreaElement>
    onFocusChange: (isFocused: boolean) => void
    onInputChange: (value: string) => void
    onQuoteChange: (quote: string | null) => void
    onImagesChange: (images: string[]) => void
    onFilesChange: (files: string[]) => void
    placeholderText: string
    shouldDisableFilesAndImages: boolean
    selectFilesAndImages: () => Promise<void>
}
