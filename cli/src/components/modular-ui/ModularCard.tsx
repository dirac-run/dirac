import { Card as CardType, isFinalStatus } from "@shared/ExtensionMessage"
import { readTaskletPresentation } from "@shared/taskletPresentation"
import { Box } from "ink"
import React from "react"
import { useTerminalSize } from "../../hooks/useTerminalSize"
import { cardDisplayBody, isCommunicationCardCollapsed } from "../../utils/card-body"
import { getIconCategoryColor } from "../../utils/icon-mapping"
import { CardBody } from "./CardBody"
import { CardHeader } from "./CardHeader"
import { CardInteractions } from "./CardInteractions"

interface ModularCardProps {
	card: CardType
	scrollOffset?: number
	maxBodyLines?: number
	suppressBody?: boolean
}

export const ModularCard: React.FC<ModularCardProps> = ({ card, maxBodyLines, scrollOffset, suppressBody = false }) => {
	const { columns } = useTerminalSize()
	const { header, status, renderType, icon, requireFeedback, actions } = card
	const tasklet = readTaskletPresentation(card)
	const body = tasklet || card.taskletReceipt || card.communication ? cardDisplayBody(card) : card.body
	const categoryColor = getIconCategoryColor(icon)
	const isCollapsed = isCommunicationCardCollapsed(card)

	return (
		<Box
			borderBottom={false}
			borderColor={categoryColor}
			borderLeft
			borderRight={false}
			borderStyle="single"
			borderTop={false}
			flexDirection="column"
			paddingLeft={1}>
			<CardHeader
				header={header}
				communication={card.communication}
				icon={icon}
				isCollapsed={isCollapsed}
				status={status}
				receipt={card.taskletReceipt}
				renderWidth={Math.max(1, columns - 2)}
				tasklet={tasklet ? { ...tasklet, width: Math.max(1, columns - 2) } : undefined}
			/>
			{body && !suppressBody && !isCollapsed && (
				<Box flexDirection="column" paddingLeft={4}>
					<CardBody
						body={body}
						receipt={card.communication ? undefined : card.taskletReceipt}
						maxLines={maxBodyLines}
						renderType={card.communication ? "text" : renderType}
						scrollOffset={scrollOffset}
						previewFromStart={!!card.communication}
						renderWidth={card.communication ? Math.max(1, columns - 6) : undefined}
						stripLineAnchors={!tasklet && !card.communication}
						literal={!!card.communication}
					/>
				</Box>
			)}
			{!card.communication && !tasklet && !card.taskletReceipt && !isFinalStatus(status) && (
				<CardInteractions
					actions={actions}
					feedbackPlaceholder={card.feedbackPlaceholder}
					requireFeedback={requireFeedback}
				/>
			)}
		</Box>
	)
}
