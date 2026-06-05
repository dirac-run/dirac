import { Box, Text } from "ink"
import Spinner from "ink-spinner"
import React from "react"
import { Card as CardType, CardStatus } from "@shared/ExtensionMessage"

interface CardProps {
	card: CardType
	isStreaming?: boolean
}

export const Card: React.FC<CardProps> = ({ card, isStreaming }) => {
	const { header, status, body } = card

	const getStatusIcon = () => {
		switch (status) {
			case CardStatus.PENDING:
				return <Text color="yellow">⏳</Text>
			case CardStatus.RUNNING:
				return (
					<Text color="cyan">
						<Spinner type="dots" />
					</Text>
				)
			case CardStatus.SUCCESS:
				return <Text color="green">✅</Text>
			case CardStatus.ERROR:
				return <Text color="red">❌</Text>
			case CardStatus.SKIPPED:
				return <Text color="gray">⏭</Text>
			case CardStatus.ABANDONED:
				return <Text color="gray">👻</Text>
			default:
				return null
		}
	}

	const getHeaderColor = () => {
		switch (status) {
			case CardStatus.ERROR:
				return "red"
			case CardStatus.SUCCESS:
				return "green"
			case CardStatus.RUNNING:
				return "cyan"
			default:
				return "white"
		}
	}

	return (
		<Box flexDirection="column" marginBottom={1} width="100%">
			<Box flexDirection="row">
				<Box width={3}>{getStatusIcon()}</Box>
				<Box flexGrow={1}>
					<Text bold color={getHeaderColor()}>
						{header}
					</Text>
				</Box>
			</Box>
			{body && !card.collapsed && (
				<Box marginLeft={3} marginTop={0}>
					<Text color="gray">{body}</Text>
				</Box>
			)}
		</Box>
	)
}
