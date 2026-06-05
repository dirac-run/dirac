import { CardDecorator } from "./types"
import { Card, CardStatus } from "@shared/ExtensionMessage"
import { DiracIcon } from "@shared/icons"
import { Button } from "@/shared/ui/button"
import { TaskServiceClient } from "@/shared/api/grpc-client"
import { StringRequest } from "@shared/proto/dirac/common"

export const CompletionDecorator: CardDecorator = {
	id: "completion",
	shouldApply: (card: Card) => card.icon === DiracIcon.COMPLETE,
	renderBodyWrapper: (_card: Card, children: React.ReactNode) => (
		<div className="border-l-2 border-l-green-500/50">{children}</div>
	),
	renderFooterExtra: (card: Card) => {
		if (card.status !== CardStatus.SUCCESS) return null

		const handleViewChanges = () => {
			TaskServiceClient.taskCompletionViewChanges(StringRequest.create({ value: card.id }))
		}

		return (
			<div className="flex flex-col gap-2 p-3 border-t border-foreground/10">
				<Button variant="success" size="sm" className="w-full gap-2 h-8 text-xs" onClick={handleViewChanges}>
					<i className="codicon codicon-new-file" />
					View Changes
				</Button>
			</div>
		)
	},
}
