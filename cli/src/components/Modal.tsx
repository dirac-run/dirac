import { Box, Text } from "ink"
import React from "react"
import { COLORS } from "../constants/colors"
import { useTerminalSize } from "../hooks/useTerminalSize"

interface ModalProps {
    title?: string
    width: number
    height: number
    borderColor?: string
    footer?: React.ReactNode
    children: React.ReactNode
}

export const Modal: React.FC<ModalProps> = ({
    title,
    width,
    height,
    borderColor = COLORS.primaryBlue,
    footer,
    children,
}) => {
    const { columns, rows } = useTerminalSize()
    const modalWidth = Math.max(1, Math.min(width, columns))
    const modalHeight = Math.max(1, Math.min(height, rows))

    return (
        <Box
            {...({
                position: "absolute",
                width: columns,
                height: rows,
                flexDirection: "column",
                justifyContent: "center",
                alignItems: "center",
            } as any)}>
            <Box
                borderColor={borderColor}
                borderStyle="round"
                flexDirection="column"
                height={modalHeight}
                paddingX={1}
                width={modalWidth}>
                {title && (
                    <Box flexShrink={0}>
                        <Text bold color={borderColor}>{title}</Text>
                    </Box>
                )}
                <Box flexDirection="column" flexGrow={1} overflow="hidden">
                    {children}
                </Box>
                {footer && (
                    <Box flexShrink={0}>
                        {footer}
                    </Box>
                )}
            </Box>
        </Box>
    )
}
