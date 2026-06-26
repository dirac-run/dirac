import { Card, CardStatus } from "@shared/ExtensionMessage"
import { CardDecorator } from "./types"
import { Badge } from "@/shared/ui/badge"
import { Button } from "@/shared/ui/button"
import { TaskServiceClient } from "@/shared/api/grpc-client"
import { EmptyRequest } from "@shared/proto/dirac/common"

export const HookDecorator: CardDecorator = {
	id: "hook",
	shouldApply: (card: Card) => card.icon === "hook" || card.header.toLowerCase().startsWith("hook:"),
	renderHeaderActions: (card: Card) => {
		// Ported from HookMessage: Extract exit code if present in body
		const exitCodeMatch = card.body?.match(/\(exit: (\d+)\)/)
		const isRunning = card.status === CardStatus.RUNNING

		return (
			<div className="flex items-center gap-2">
				{exitCodeMatch && (
					<Badge variant="default" className="text-[10px] px-1 py-0 opacity-70">
						exit: {exitCodeMatch[1]}
					</Badge>
				)}
				{isRunning && (
					<Button
						variant="secondary"
						size="xs"
						className="h-5 text-[10px] px-1.5"
						onClick={(e) => {
							e.stopPropagation()
							TaskServiceClient.cancelTask(EmptyRequest.create({})).catch((err) =>
								console.error("Failed to cancel task from HookDecorator:", err),
							)
						}}>
						Abort
					</Button>
				)}
			</div>
		)
	},
}
