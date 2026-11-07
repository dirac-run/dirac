import { theme } from "../constants/theme"
/**
 * Help panel content for inline display in ChatView
 * Explains Dirac CLI features and links to documentation
 */

import { Box, Text, useInput } from "ink"
import React from "react"
import { COLORS } from "../constants/colors"
import { useStdinContext } from "../context/StdinContext"
import { useTerminalSize } from "../hooks/useTerminalSize"
import { shouldIgnoreTerminalInput } from "../utils/input"
import { Panel } from "./Panel"

interface HelpPanelContentProps {
	onClose: () => void
}

export const HelpPanelContent: React.FC<HelpPanelContentProps> = ({ onClose }) => {
	const { isRawModeSupported } = useStdinContext()
	const { columns } = useTerminalSize()
	const separatorWidth = Math.max(1, Math.min(40, columns - 4))
	const keyColumnWidth = Math.max(10, Math.min(22, Math.floor(columns * 0.35)))

	useInput(
		(input, key) => {
			if (shouldIgnoreTerminalInput(input, key)) {
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
					<Text bold color={COLORS.primaryBlue}>
						Plan vs Act Mode
					</Text>
					<Text>
						Use <Text color={theme.warning}>Plan</Text> mode to discuss and strategize before making changes. Use{" "}
						<Text color={COLORS.primaryBlue}>Act</Text> mode when you're ready for Dirac to edit files and run
						commands. Toggle between them with <Text color={theme.text}>Tab</Text>.
					</Text>
				</Box>

				<Text color={theme.muted}>{"─".repeat(separatorWidth)}</Text>

				<Box flexDirection="column">
					<Text bold color={COLORS.primaryBlue}>
						Keyboard Shortcuts
					</Text>
					{[
						["Enter", "Submit prompt"],
						["Shift+Enter / Shift+↓", "Insert newline (Shift+↓ is the fallback)"],
						["Ctrl+U", "Clear entire input (delete to start)"],
						["Ctrl+K", "Delete from cursor to end"],
						["Ctrl+W", "Delete word backwards"],
						["Ctrl+A / Ctrl+E", "Jump to start / end of input"],
						["Alt/Option+←/→", "Move by word"],
						["↑ / ↓", "Move cursor; scroll response at input edges"],
						["Ctrl+↑ / Ctrl+↓", "Recall previous prompts for editing"],
						["Tab", "Switch Plan/Act mode"],
						["Shift+Tab", "Toggle auto-approve"],
						["Esc", "Cancel current action"],
						["Ctrl+C", "Interrupt / exit"],
					].map(([key, desc], i) => (
						<Text key={i}>
							{"  "}
							<Box width={keyColumnWidth}>
								<Text color={theme.text}>{key}</Text>
							</Box>
							<Text>{desc}</Text>
						</Text>
					))}
				</Box>

				<Text color={theme.muted}>{"─".repeat(separatorWidth)}</Text>

				<Box flexDirection="column">
					<Text bold color={COLORS.primaryBlue}>
						Slash Commands
					</Text>
					<Text>
						Type <Text color={theme.text}>/</Text> to see available commands. Key ones include:
					</Text>
					{[
						["/settings", "Configure your API provider and preferences"],
						["/models", "Switch AI models"],
						["/history", "Browse previous tasks"],
						["/agents", "Print a frozen local snapshot of active agents"],
						["/agent", "Read agent transcripts; r refresh, n/p pages (no chat/control)"],
						["/quiet", "Toggle card bodies for future tool output"],
						["/clear", "Start a fresh task"],
						["/q", "Quit Dirac"],
					].map(([cmd, desc], i) => (
						<Text key={i}>
							{"  "}
							<Box width={keyColumnWidth}>
								<Text color={theme.text}>{cmd}</Text>
							</Box>
							<Text>{desc}</Text>
						</Text>
					))}
				</Box>

				<Text color={theme.muted}>{"─".repeat(separatorWidth)}</Text>

				<Text>
					For more help use /askDirac or go to <Text color={COLORS.primaryBlue}>https://dirac.run/docs/dirac</Text>
				</Text>
			</Box>
		</Panel>
	)
}
