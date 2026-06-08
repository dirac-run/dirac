import React, { useMemo } from "react"
import { Box, Text } from "ink"
import { HighlightedInput } from "./HighlightedInput"

interface ChatInputBarProps {
    borderColor: string
    inputPrompt?: string
    textInput: string
    cursorPos: number
    availableCommands: string[]
    show?: boolean
    terminalColumns?: number
    terminalRows?: number
}

export const ChatInputBar: React.FC<ChatInputBarProps> = ({
    borderColor,
    inputPrompt,
    textInput,
    cursorPos,
    availableCommands,
    show = true,
    terminalColumns,
    terminalRows,
}) => {

    const MAX_INPUT_LINES = 10
    const BORDER_OVERHEAD = 4 // border chars + padding

    const maxInputHeight = MAX_INPUT_LINES

    const contentWidth = (terminalColumns ?? 80) - BORDER_OVERHEAD

    /**
     * Front-clip text so its wrapped visual line count fits within maxInputHeight.
     * Returns the clipped text and how many characters were removed from the front.
     */
    const { clippedText, adjustedCursorPos } = useMemo(() => {
        if (!textInput) return { clippedText: "", adjustedCursorPos: 0 }

        // Split by explicit newlines and count visual (wrapped) lines
        const logicalLines = textInput.split("\n")
        let totalVisualLines = 0
        for (const line of logicalLines) {
            totalVisualLines += Math.max(1, Math.ceil(line.length / Math.max(1, contentWidth)))
        }

        if (totalVisualLines <= maxInputHeight) {
            return { clippedText: textInput, adjustedCursorPos: cursorPos }
        }

        // Walk backwards from the end, accumulating visual lines until we fill maxInputHeight
        let linesFromEnd = 0
        let charIndex = textInput.length
        for (let i = logicalLines.length - 1; i >= 0; i--) {
            const line = logicalLines[i]
            const lineVisual = Math.max(1, Math.ceil(line.length / Math.max(1, contentWidth)))
            if (linesFromEnd + lineVisual > maxInputHeight) {
                // Partial line: take the tail that fits
                const remainingVisualLines = maxInputHeight - linesFromEnd
                const charsThatFit = remainingVisualLines * contentWidth
                charIndex -= charsThatFit
                linesFromEnd = maxInputHeight
                break
            }
            linesFromEnd += lineVisual
            charIndex -= line.length
            if (i > 0) charIndex -= 1 // account for the \n separator
        }

        charIndex = Math.max(0, charIndex)
        const prefix = "..."
        const visible = textInput.slice(charIndex)
        const clipped = prefix + visible
        const adjusted = Math.max(0, cursorPos - charIndex + prefix.length)

        return { clippedText: clipped, adjustedCursorPos: adjusted }
    }, [textInput, cursorPos, contentWidth, maxInputHeight])
    if (!show) return null

    return (
        <Box flexDirection="column" width="100%">
            <Box
                borderColor={borderColor}
                borderStyle="round"
                flexDirection="row"
                justifyContent="space-between"
                paddingLeft={1}
                paddingRight={1}
                maxHeight={maxInputHeight + 2}
                overflow="hidden"
                width="100%">
                <Box>
                    {inputPrompt && <Text color={borderColor} bold>{inputPrompt} </Text>}
                    <HighlightedInput availableCommands={availableCommands} cursorPos={adjustedCursorPos} text={clippedText} />
                </Box>
            </Box>
        </Box>
    )
}
