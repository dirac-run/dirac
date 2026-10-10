import { isSuccessfulTaskCompletionCard } from "@shared/cardIdentity"
import { DiracMessageType, SteeringTranscriptStatus, type DiracMessage } from "@shared/ExtensionMessage"
import type { DiracContent, DiracTextContentBlock } from "@shared/messages/content"

function isTaskRequest(text: string): boolean {
	return text.trim().length > 0 && !/^\/(?:compact|smol)\s*$/.test(text.trim())
}

/** Reads user intent independently of truncated API history and generated summaries. */
export function getCurrentTurnUserRequests(
	history: readonly DiracMessage[],
	pendingUserContent: readonly DiracContent[] = [],
): string[] {
	const requests: string[] = []
	for (const message of history) {
		const content = message.content
		if (content.type === DiracMessageType.CARD && isSuccessfulTaskCompletionCard(content.card)) {
			requests.length = 0
			continue
		}
		if (content.type !== DiracMessageType.MARKDOWN || content.role !== "user") continue
		if (content.steering && content.steering.status !== SteeringTranscriptStatus.SENT) continue
		if (isTaskRequest(content.content)) requests.push(content.content)
	}

	// Automatic Utility condensation precedes persistence of the next API message.
	// Only explicitly marked human input is eligible, never tool results or queued steering.
	for (const block of pendingUserContent) {
		if (block.type !== "text") continue
		const textBlock = block as DiracTextContentBlock
		if (!textBlock.isUserInput || textBlock.steeringMessageIds) continue
		const wrapper = /^<(task|feedback|answer|user_message)>\n?([\s\S]*?)\n?<\/\1>$/.exec(textBlock.text)
		const text = wrapper ? wrapper[2] : textBlock.text
		if (!isTaskRequest(text) || requests.at(-1)?.trim() === text.trim()) continue
		requests.push(text)
	}
	return requests
}

/** JSON keeps arbitrary request text separate from the generated condensation. */
export function formatCurrentTurnUserRequests(requests: readonly string[]): string {
	return `=== CURRENT TURN USER REQUESTS (verbatim, oldest to newest; since the latest successful completion, or session start) ===\n${JSON.stringify(requests)}`
}
