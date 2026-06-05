import { DiracMessage } from "@shared/ExtensionMessage"
import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { ChatState } from "../types/chatTypes"
import { useChatStore } from "@/features/chat/store/chatStore"
import { useShallow } from "zustand/react/shallow"


/**
 * Custom hook for managing chat state
 * Handles input values, selection states, and UI state
 */
export function useChatState(messages: DiracMessage[]): ChatState {
    // Input and selection state
    const [inputValue, setInputValue] = useState("")
    const [activeQuote, setActiveQuote] = useState<string | null>(null)
    const [isTextAreaFocused, setIsTextAreaFocused] = useState(false)
    const [selectedImages, setSelectedImages] = useState<string[]>([])
    const [selectedFiles, setSelectedFiles] = useState<string[]>([])

    // UI state
    const [sendingDisabled, setSendingDisabled] = useState(false)
    const [expandedRows, setExpandedRows] = useState<Record<string, boolean>>({})

    // Refs
    const textAreaRef = useRef<HTMLTextAreaElement>(null)

    // Derived state
    const lastMessage = useMemo(() => messages.at(-1), [messages])
    const secondLastMessage = useMemo(() => messages.at(-2), [messages])

    // Clear expanded rows when task changes
    const task = useMemo(() => messages.at(0), [messages])
    const clearExpandedRows = useCallback(() => {
        setExpandedRows({})
    }, [])

    // Reset state when starting new conversation
    const resetState = useCallback(() => {
        setInputValue("")
        setActiveQuote(null)
        setSelectedImages([])
        setSelectedFiles([])
    }, [])

    // Handle focus change
    const handleFocusChange = useCallback((isFocused: boolean) => {
        setIsTextAreaFocused(isFocused)
    }, [])

    // Auto-expand last message row when task or messages first changed.
    useEffect(() => {
        clearExpandedRows()
    }, [task?.id, clearExpandedRows])

    return {
        // State values
        inputValue,
        setInputValue,
        activeQuote,
        setActiveQuote,
        isTextAreaFocused,
        setIsTextAreaFocused,
        selectedImages,
        setSelectedImages,
        selectedFiles,
        setSelectedFiles,
        sendingDisabled,
        setSendingDisabled,
        expandedRows,
        setExpandedRows,

        // Refs
        textAreaRef,

        // Derived values
        lastMessage,
        secondLastMessage,
        task,
        ...useChatStore(
            useShallow((state) => ({
                uiActionState: state.uiActionState,
                activeVoiceStreamId: state.activeVoiceStreamId,
                isApiRequestActive: state.isApiRequestActive,
                taskStatus: state.taskStatus,
            }))
        ),


        // Handlers
        handleFocusChange,
        clearExpandedRows,
        resetState,
    }
}
