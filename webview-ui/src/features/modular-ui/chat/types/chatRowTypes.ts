import { DiracMessage, Mode } from "@shared/ExtensionMessage"

export interface ChatRowProps {
    message: DiracMessage
    isExpanded: boolean
    onToggleExpand: (ts: number) => void
    lastModifiedMessage?: DiracMessage
    isLast: boolean
    inputValue?: string
    sendMessageFromChatRow?: (text: string, images: string[], files: string[]) => void
    onSetQuote: (text: string) => void
    onCancelCommand?: () => void
    mode?: Mode
    reasoningContent?: string
    responseStarted?: boolean
    isRequestInProgress?: boolean
    onApprove?: (cardId?: string) => void
    onReject?: (cardId?: string) => void
    onAction?: (value: string, cardId?: string) => void
    activeCardId?: string
    activeVoiceStreamId?: string

}




export type DisplayUnitStatus = "pending" | "active" | "success" | "error"

export interface DisplayUnit {
    id: string // Unique ID for the row
    type: string // tool name or category
    label: string // Primary text (e.g., filename, command)
    subLabel?: string // Secondary metadata (e.g., line ranges, edit stats)
    status: DisplayUnitStatus
    icon: any // Lucide icon component
    isExpandable: boolean
    content?: string // Expanded detail (diff, file content, etc.)
    path?: string // For file-related actions
    isFilePath?: boolean // Whether the path points to a specific file (vs directory/cwd)
    symbol?: string // For symbol-related actions (replace_symbol, etc.)
    hasComponent?: boolean // Whether a specialized component is handling the expansion
    toolName?: string // The raw tool name for tooltip
}
