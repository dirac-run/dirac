import { Card } from "@shared/ExtensionMessage"
import { SquareArrowOutUpRightIcon } from "lucide-react"
import React from "react"
import { CardDecorator } from "./types"
import { FileServiceClient } from "@/shared/api/grpc-client"
import { StringRequest } from "@shared/proto/dirac/common"

export const DiffDecorator: CardDecorator = {
	id: "diff",
	shouldApply: (card: Card) => card.renderType === "diff",
	renderHeaderActions: (card: Card) => {
		const handleOpenFile = (e: React.MouseEvent) => {
			e.stopPropagation()
			// Heuristic: the header often contains the file path for diff cards
			const path = card.header.trim()
			if (path) {
				FileServiceClient.openFileRelativePath(StringRequest.create({ value: path })).catch((err) =>
					console.error("Failed to open file from ModularCard:", err),
				)
			}
		}

		return (
			<button
				className="p-1 hover:bg-foreground/10 rounded-sm transition-colors"
				onClick={handleOpenFile}
				title="Open file in editor">
				<SquareArrowOutUpRightIcon className="size-3.5 text-muted-foreground hover:text-foreground" />
			</button>
		)
	},
}
