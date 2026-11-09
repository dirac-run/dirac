import type { Card, RenderType } from "@shared/ExtensionMessage"
import { readTaskletPresentation } from "@shared/taskletPresentation"
import { formatTaskletReceipt } from "@shared/taskletReceipt"
import { stripHashes, stripHashesFromDiff } from "@shared/utils/line-hashing"
import { clipTextToWindow } from "./text-clipping"

export const COMMUNICATION_PREVIEW_LINES = 6

/** Legacy communication cards explicitly set collapsed:false. Read them in /agent → c instead. */
export function isCommunicationCardCollapsed(card: Card): boolean {
	return !!card.communication
}

/** Pipe mode has no scrollback control, so keep the beginning and mark omitted content. */
export function communicationBodyPreview(body: string, columns: number): string {
	const { visibleText, hasMoreBelow } = clipTextToWindow(
		body,
		COMMUNICATION_PREVIEW_LINES,
		columns,
		Number.MAX_SAFE_INTEGER,
		"",
	)
	return `${visibleText}${hasMoreBelow ? "\n… more communication content" : ""}`
}

/** Removes model-facing line anchors from a card body before displaying it. */
export function cardBodyForDisplay(body: string | undefined, renderType: RenderType): string {
	if (!body) return ""
	return renderType === "diff" ? stripHashesFromDiff(body) : stripHashes(body)
}

/** Display the shared tasklet projection; retain legacy body readers for other cards. */
export function cardDisplayBody(card: Card): string {
	if (card.communication) return card.body ?? ""
	if (card.taskletReceipt) return formatTaskletReceipt(card.taskletReceipt)
	const tasklet = readTaskletPresentation(card)
	if (!tasklet) return cardBodyForDisplay(card.body, card.renderType)

	return [
		`Prompt\n${tasklet.prompt}`,
		tasklet.status === "waiting" ? "Waiting for the parent; no user approval is requested here." : undefined,
		tasklet.result === undefined ? undefined : `Result\n${tasklet.result}`,
		tasklet.communications.length > 0
			? `Communications (parent-directed)\n${tasklet.communications.join("\n\n")}`
			: undefined,
		tasklet.activity.length > 0 ? `Activity (diagnostic)\n${tasklet.activity.join("\n\n")}` : undefined,
	]
		.filter(Boolean)
		.join("\n\n")
}
