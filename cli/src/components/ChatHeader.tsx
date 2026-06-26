import React from "react"
import { Box, Text } from "ink"
import { AsciiMotionCli, StaticRobotFrame } from "./AsciiMotionCli"
import { centerText } from "../utils/display"
import { version as CLI_VERSION } from "../../package.json"

interface ChatHeaderProps {
	isWelcomeState?: boolean
	quote?: string
	onInteraction?: (input: string, key: any) => void
}

export const ChatHeader: React.FC<ChatHeaderProps> = ({ isWelcomeState, quote, onInteraction }) => {
	const content = (
		<React.Fragment>
			{isWelcomeState ? <AsciiMotionCli onInteraction={onInteraction} /> : <StaticRobotFrame />}
			<Text> </Text>
			<Text bold color="white">
				{centerText(`Questions about Dirac? Query the code (v${CLI_VERSION}) directly using /askDirac`)}
			</Text>
			{isWelcomeState && quote ? (
				<Box marginTop={1}>
					<Text color="cyan" italic>
						{centerText(`“${quote}”`)}
					</Text>
				</Box>
			) : (
				<Text> </Text>
			)}
		</React.Fragment>
	)

	return <Box flexDirection="column">{content}</Box>
}
