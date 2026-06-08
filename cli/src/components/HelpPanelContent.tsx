/**
 * Help panel content for inline display in ChatView
 * Explains Dirac CLI features and links to documentation
 */

import { Box, Text, useInput } from "ink"
import React from "react"
import { COLORS } from "../constants/colors"
import { useStdinContext } from "../context/StdinContext"
import { isMouseEscapeSequence } from "../utils/input"
import { Panel } from "./Panel"

interface HelpPanelContentProps {
    onClose: () => void
}

export const HelpPanelContent: React.FC<HelpPanelContentProps> = ({ onClose }) => {
    const { isRawModeSupported } = useStdinContext()

    useInput(
        (input, key) => {
            if (isMouseEscapeSequence(input)) {
                return
            }
            if (key.escape) {
                onClose()
            }
        },
        { isActive: isRawModeSupported },
    )

    return (
        <Panel label="Help">
            <Box flexDirection="column" gap={1}>
                <Text>Dirac can edit files, run terminal commands, use the browser, and more with your permission.</Text>

                <Box flexDirection="column">
                    <Text bold color={COLORS.primaryBlue}>Plan vs Act Mode</Text>
                    <Text>
                        Use <Text color="yellow">Plan</Text> mode to discuss and strategize before making changes. Use{" "}
                        <Text color={COLORS.primaryBlue}>Act</Text> mode when you're ready for Dirac to edit files and run
                        commands. Toggle between them with <Text color="white">Tab</Text>.
                    </Text>
                </Box>

                <Text color="gray">{"─".repeat(40)}</Text>

                <Box flexDirection="column">
                    <Text bold color={COLORS.primaryBlue}>Keyboard Shortcuts</Text>
                    {[
                        ["Ctrl+U", "Clear entire input (delete to start)"],
                        ["Ctrl+K", "Delete from cursor to end"],
                        ["Ctrl+W", "Delete word backwards"],
                        ["Ctrl+A / Ctrl+E", "Jump to start / end of input"],
                        ["Alt/Option+←/→", "Move by word"],
                        ["Tab", "Switch Plan/Act mode"],
                        ["Shift+Tab", "Toggle auto-approve"],
                        ["b", "Toggle verbose batch details"],
                        ["Esc", "Cancel current action"],
                        ["Ctrl+C", "Interrupt / exit"],
                    ].map(([key, desc], i) => (
                        <Text key={i}>
                            {"  "}
                            <Box width={22}><Text color="white">{key}</Text></Box>
                            <Text>{desc}</Text>
                        </Text>
                    ))}
                </Box>

                <Text color="gray">{"─".repeat(40)}</Text>

                <Box flexDirection="column">
                    <Text bold color={COLORS.primaryBlue}>Slash Commands</Text>
                    <Text>
                        Type <Text color="white">/</Text> to see available commands. Key ones include:
                    </Text>
                    {[
                        ["/settings", "Configure your API provider and preferences"],
                        ["/models", "Switch AI models"],
                        ["/history", "Browse previous tasks"],
                        ["/clear", "Start a fresh task"],
                        ["/q", "Quit Dirac"],
                    ].map(([cmd, desc], i) => (
                        <Text key={i}>
                            {"  "}
                            <Box width={22}><Text color="white">{cmd}</Text></Box>
                            <Text>{desc}</Text>
                        </Text>
                    ))}
                </Box>

                <Text color="gray">{"─".repeat(40)}</Text>

                <Text>
                    For more help: <Text color={COLORS.primaryBlue}>https://dirac.run/docs/dirac</Text>
                </Text>
            </Box>
        </Panel>
    )
}
