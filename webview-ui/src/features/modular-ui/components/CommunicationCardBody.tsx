import type { Card } from "@shared/ExtensionMessage"
import { useState } from "react"

const PREVIEW_CHARACTERS = 480
const PREVIEW_LINES = 5

/** Outgoing communication is literal content, not executable controls or a tool result. */
export function CommunicationCardBody({ card }: { card: Card }) {
	const [expanded, setExpanded] = useState(false)
	const body = card.body ?? ""
	const preview = body.split("\n").slice(0, PREVIEW_LINES).join("\n").slice(0, PREVIEW_CHARACTERS)
	const hasMore = preview.length < body.length
	const bodyId = `communication-content-${card.id}`
	return (
		<div className="flex flex-col gap-2 border-t border-foreground/10 p-2.5">
			{body && (
				<div
					className="overflow-y-auto whitespace-pre-wrap break-words text-sm leading-relaxed"
					id={bodyId}
					style={{ maxHeight: 320 }}>
					{expanded ? body : preview}
					{!expanded && hasMore ? "…" : ""}
				</div>
			)}
			{hasMore && (
				<button
					aria-controls={bodyId}
					aria-expanded={expanded}
					className="self-start rounded-sm text-xs text-link hover:underline focus-visible:outline-2 focus-visible:outline-ring"
					onClick={() => setExpanded(!expanded)}
					type="button">
					{expanded ? "Show less" : "Show more"}
				</button>
			)}
			{card.communication?.detail && (
				<div className="truncate text-xs text-muted-foreground" title={card.communication.detail}>
					{card.communication.detail}
				</div>
			)}
		</div>
	)
}
