/**
 * Utility functions for message filtering, grouping, and manipulation
 */

import { DiracMessage, DiracMessageType, CardStatus } from "@shared/ExtensionMessage"

/**
 * Low-stakes tool types that should be grouped together
 */
const LOW_STAKES_TOOLS = new Set([
	"readFile",
	"readLineRange",
	"listFilesTopLevel",
	"listFilesRecursive",
	"listCodeDefinitionNames",
	"searchFiles",
	"getFileSkeleton",
	"getFunction"
])

/**
 * Check if a tool message is a low-stakes tool
 */
export function isLowStakesTool(message: DiracMessage): boolean {
	if (message.content.type !== DiracMessageType.CARD) {
		return false
	}
	const card = message.content.card
	// We assume tool name is in the header or we can't easily tell without more metadata
	// For now, we'll check if the header matches any low-stakes tool name
	return LOW_STAKES_TOOLS.has(card.header)
}

/**
 * Check if a message group is a tool group (array with _isToolGroup marker)
 */
export function isToolGroup(item: DiracMessage | DiracMessage[]): item is DiracMessage[] & { _isToolGroup: true } {
	return Array.isArray(item) && (item as any)._isToolGroup === true
}


/**
 * Filter messages that should be visible in the chat
 */
export function filterVisibleMessages(messages: DiracMessage[]): DiracMessage[] {
	// Find the index of the last api_status message that has a request field
	let lastApiStatusIndex = -1
	for (let i = messages.length - 1; i >= 0; i--) {
		const msgContent = messages[i].content
		if (msgContent.type === DiracMessageType.API_STATUS) {
			if (msgContent.status.request) {
				lastApiStatusIndex = i
				break
			}
		}
	}

	return messages.filter((message, index) => {
		const content = message.content
		if (content.type === DiracMessageType.CHECKPOINT) {
			return true
		}

		if (content.type === DiracMessageType.API_STATUS) {
			// Show if it's the latest one (current request) OR if it has cost/token data (completed request)
			return index === lastApiStatusIndex || content.status.cost !== undefined || content.status.tokensIn !== undefined
		}

		if (content.type === DiracMessageType.MARKDOWN) {
			if ((content.content ?? "") === "" && (content.images?.length ?? 0) === 0) {
				return false
			}
		}

		// Cards are generally visible unless they are specific system cards we want to hide
		return true
	})
}

/**
 * Check if a message is part of a browser session
 */
export function isBrowserSessionMessage(message: DiracMessage): boolean {
	if (message.content.type === DiracMessageType.CARD) {
		return message.content.card.header.toLowerCase().includes("browser")
	}
	if (message.content.type === DiracMessageType.API_STATUS) {
		return true
	}
	if (message.content.type === DiracMessageType.MARKDOWN) {
		return true
	}
	return false
}

/**
 * Group messages, combining browser session messages into arrays
 */
export function groupMessages(visibleMessages: DiracMessage[]): (DiracMessage | DiracMessage[])[] {
	const result: (DiracMessage | DiracMessage[])[] = []
	let currentGroup: DiracMessage[] = []
	let isInBrowserSession = false

	const endBrowserSession = () => {
		if (currentGroup.length > 0) {
			result.push([...currentGroup])
			currentGroup = []
			isInBrowserSession = false
		}
	}

	for (const message of visibleMessages) {
		const isBrowserAction = message.content.type === DiracMessageType.CARD && 
								message.content.card.header.toLowerCase().includes("browser") &&
								message.content.card.header.toLowerCase().includes("launch")

		if (isBrowserAction) {
			endBrowserSession()
			isInBrowserSession = true
			currentGroup.push(message)
		} else if (isInBrowserSession) {
			const msgContent = message.content
			if (msgContent.type === DiracMessageType.API_STATUS) {
				const info = msgContent.status
				const isCancelled = info.cancelReason != null
				if (isCancelled) {
					endBrowserSession()
					result.push(message)
					continue
				}
			}

			if (isBrowserSessionMessage(message)) {
				currentGroup.push(message)
				const isBrowserClose = message.content.type === DiracMessageType.CARD && 
									   message.content.card.header.toLowerCase().includes("browser") &&
									   message.content.card.header.toLowerCase().includes("close")
				if (isBrowserClose) {
					endBrowserSession()
				}
			} else {
				endBrowserSession()
				result.push(message)
			}
		} else {
			result.push(message)
		}
	}

	if (currentGroup.length > 0) {
		result.push([...currentGroup])
	}

	return result
}

/**
 * Get the task message from the messages array
 */
export function getTaskMessage(messages: DiracMessage[]): DiracMessage | undefined {
	return messages.at(0)
}

/**
 * Check if we should show the scroll to bottom button
 */
export function shouldShowScrollButton(disableAutoScroll: boolean, isAtBottom: boolean): boolean {
	return disableAutoScroll && !isAtBottom
}

/**
 * Find reasoning content associated with an api_req_started message.
 */
export function findReasoningForApiReq(
	apiReqTs: number,
	allMessages: DiracMessage[],
): { reasoning: string | undefined; responseStarted: boolean } {
	const apiReqIndex = allMessages.findIndex((m) => m.ts === apiReqTs && m.content.type === DiracMessageType.API_STATUS)
	if (apiReqIndex === -1) {
		return { reasoning: undefined, responseStarted: false }
	}

	const reasoningParts: string[] = []
	let responseStarted = false

	for (let i = apiReqIndex + 1; i < allMessages.length; i++) {
		const msg = allMessages[i]
		if (msg.content.type === DiracMessageType.API_STATUS) {
			break
		}
		if (msg.content.type === DiracMessageType.MARKDOWN && msg.content.isReasoning && msg.content.content) {
			reasoningParts.push(msg.content.content)
		}
		if (msg.content.type === DiracMessageType.MARKDOWN && !msg.content.isReasoning) {
			responseStarted = true
		}
		if (msg.content.type === DiracMessageType.CARD) {
			responseStarted = true
		}
	}

	return {
		reasoning: reasoningParts.length > 0 ? reasoningParts.join("\n\n") : undefined,
		responseStarted,
	}
}

/**
 * Find the API request info for a checkpoint message.
 */
export function findApiReqInfoForCheckpoint(
	checkpointTs: number,
	allMessages: DiracMessage[],
): { cost: number | undefined; request: string | undefined } {
	const checkpointIndex = allMessages.findIndex((m) => m.ts === checkpointTs && (m.content.type === DiracMessageType.CHECKPOINT || (m.content.type === DiracMessageType.CARD && m.content.card.header.includes("Checkpoint"))))
	if (checkpointIndex === -1) {
		return { cost: undefined, request: undefined }
	}

	for (let i = checkpointIndex - 1; i >= 0; i--) {
		const msg = allMessages[i]
		const msgContent = msg.content
		if (msgContent.type === DiracMessageType.API_STATUS) {
			return {
				cost: msgContent.status.cost,
				request: msgContent.status.request,
			}
		}
	}
	return { cost: undefined, request: undefined }
}

/**
 * Check if a checkpoint at the given index would be displayed (not absorbed into a tool group).
 */
function isDisplayedCheckpoint(checkpointIndex: number, allMessages: DiracMessage[]): boolean {
	for (let i = checkpointIndex - 1; i >= 0; i--) {
		const msg = allMessages[i]
		if (msg.content.type === DiracMessageType.API_STATUS) {
			continue
		}
		if (msg.content.type === DiracMessageType.MARKDOWN && msg.content.isReasoning) {
			continue
		}
		if (msg.content.type === DiracMessageType.CHECKPOINT || (msg.content.type === DiracMessageType.CARD && msg.content.card.header.includes("Checkpoint"))) {
			continue
		}
		if (msg.content.type === DiracMessageType.CARD) {
			if (isLowStakesTool(msg)) {
				return false
			}
		}
		return true
	}
	return true
}

/**
 * Find the total cost for the segment starting at a checkpoint.
 */
export function findNextSegmentCost(checkpointTs: number, allMessages: DiracMessage[]): number | undefined {
	const checkpointIndex = allMessages.findIndex((m) => m.ts === checkpointTs && (m.content.type === DiracMessageType.CHECKPOINT || (m.content.type === DiracMessageType.CARD && m.content.card.header.includes("Checkpoint"))))
	if (checkpointIndex === -1) {
		return undefined
	}
	let nextDisplayedCheckpointIndex = -1
	for (let i = checkpointIndex + 1; i < allMessages.length; i++) {
		const content = allMessages[i].content
		if (content.type === DiracMessageType.CHECKPOINT || (content.type === DiracMessageType.CARD && content.card.header.includes("Checkpoint"))) {

			if (isDisplayedCheckpoint(i, allMessages)) {
				nextDisplayedCheckpointIndex = i
				break
			}
		}
	}

	const endIndex = nextDisplayedCheckpointIndex === -1 ? allMessages.length : nextDisplayedCheckpointIndex
	let totalCost = 0
	for (let i = checkpointIndex + 1; i < endIndex; i++) {
		const msg = allMessages[i]
		const msgContent = msg.content
		if (msgContent.type === DiracMessageType.API_STATUS) {
			if (typeof msgContent.status.cost === "number") {
				totalCost += msgContent.status.cost
			}
		}
	}

	return totalCost > 0 ? totalCost : undefined
}

/**
 * Check if a text message's associated API request is still in progress.
 */
export function isTextMessagePendingToolCall(textTs: number, allMessages: DiracMessage[]): boolean {
	const textIndex = allMessages.findIndex((m) => m.ts === textTs)
	if (textIndex === -1) {
		return false
	}

	for (let i = textIndex - 1; i >= 0; i--) {
		const msg = allMessages[i]
		const msgContent = msg.content
		if (msgContent.type === DiracMessageType.API_STATUS) {
			return msgContent.status.cost == null
		}
	}
	return false
}

/**
 * Check if a tool group should be hidden because its tools are currently being displayed in the loading state animation.
 */
export function isToolGroupInFlight(toolGroupMessages: DiracMessage[], allMessages: DiracMessage[]): boolean {
	if (toolGroupMessages.length === 0) {
		return false
	}

	let mostRecentApiReqIndex = -1
	for (let i = allMessages.length - 1; i >= 0; i--) {
		if (allMessages[i].content.type === DiracMessageType.API_STATUS) {
			mostRecentApiReqIndex = i
			break
		}
	}

	if (mostRecentApiReqIndex === -1) {
		return false
	}

	const mostRecentApiStatus = allMessages[mostRecentApiReqIndex].content as any
	const mostRecentHasCost = mostRecentApiStatus.status.cost != null

	const lastTool = [...toolGroupMessages].reverse().find((m) => isLowStakesTool(m))
	if (!lastTool) {
		return false
	}

	const toolIndex = allMessages.findIndex((m) => m.ts === lastTool.ts)
	if (toolIndex === -1) {
		return false
	}

	if (!mostRecentHasCost) {
		let prevCompletedApiReqIndex = -1
		for (let i = mostRecentApiReqIndex - 1; i >= 0; i--) {
			const msg = allMessages[i]
			if (msg.content.type === DiracMessageType.API_STATUS) {
				if (msg.content.status.cost != null) {
					prevCompletedApiReqIndex = i
					break
				}
			}
		}

		if (prevCompletedApiReqIndex === -1) {
			return false
		}
		return toolIndex > prevCompletedApiReqIndex && toolIndex < mostRecentApiReqIndex
	}
	return toolIndex > mostRecentApiReqIndex
}

/**
 * Filter a tool group to exclude tools that are in the "current activities" range.
 */
export function getToolsNotInCurrentActivities(toolGroupMessages: DiracMessage[], allMessages: DiracMessage[]): DiracMessage[] {
	const tsToIndex = new Map<number, number>()
	for (let i = 0; i < allMessages.length; i++) {
		tsToIndex.set(allMessages[i].ts, i)
	}

	let mostRecentApiReqIndex = -1
	for (let i = allMessages.length - 1; i >= 0; i--) {
		if (allMessages[i].content.type === DiracMessageType.API_STATUS) {
			mostRecentApiReqIndex = i
			break
		}
	}

	if (mostRecentApiReqIndex === -1) {
		return toolGroupMessages
	}

	const mostRecentApiStatus = allMessages[mostRecentApiReqIndex].content as any
	const mostRecentHasCost = mostRecentApiStatus.status.cost != null

	if (!mostRecentHasCost) {
		return toolGroupMessages.filter((msg) => {
			const toolIndex = tsToIndex.get(msg.ts)
			if (toolIndex === undefined) {
				return true
			}
			// If we have an in-progress request, tools after it are "current activities"
			const isInCurrentActivitiesRange = toolIndex > mostRecentApiReqIndex
			return !isInCurrentActivitiesRange
		})
	}

	return toolGroupMessages.filter((msg) => {
		if (!isLowStakesTool(msg)) {
			return true
		}
		if (msg.content.type === DiracMessageType.CARD && msg.content.card.status === CardStatus.WAITING_FOR_INPUT) {
			const toolIndex = tsToIndex.get(msg.ts)
			if (toolIndex === undefined) {
				return true
			}
			return true
		}
		return true
	})
}

/**
 * Returns true if this api_req_started should be fully absorbed into a low-stakes tool group.
 */
export function isApiReqAbsorbable(apiReqTs: number, allMessages: DiracMessage[]): boolean {
	// We no longer absorb API requests into tool groups to ensure cost/token data points remain visible
	return false
}

/**
 * Check if an api_req_started at a given index produces low-stakes tools.
 */
function isApiReqFollowedOnlyByLowStakesTools(index: number, messages: (DiracMessage | DiracMessage[])[]): boolean {
	// We no longer absorb API requests into tool groups to ensure cost/token data points remain visible
	return false
}

/**
 * Group consecutive low-stakes tools into arrays.
 */
export function groupLowStakesTools(groupedMessages: (DiracMessage | DiracMessage[])[]): (DiracMessage | DiracMessage[])[] {
	const result: (DiracMessage | DiracMessage[])[] = []
	let toolGroup: DiracMessage[] = []
	let pendingReasoning: DiracMessage[] = []
	let pendingApiReq: DiracMessage[] = []
	let hasTools = false
	let hasApiReq = false
	const pendingTools: DiracMessage[] = []

	const flushPending = () => {
		pendingApiReq.forEach((m) => result.push(m))
		pendingReasoning.forEach((m) => result.push(m))
		pendingApiReq = []
		pendingReasoning = []
		hasApiReq = false
	}

	const commitToolGroup = () => {
		if (toolGroup.length > 0 && (hasTools || hasApiReq)) {
			const group = toolGroup as DiracMessage[] & { _isToolGroup: boolean }
			group._isToolGroup = true
			result.push(group)
			pendingReasoning = []
			pendingApiReq = []
			hasApiReq = false
		}
		toolGroup = []
		hasTools = false
	}

	const absorbPending = () => {
		if (pendingApiReq.length > 0) {
			toolGroup.push(...pendingApiReq)
			pendingApiReq = []
			hasApiReq = true
		}
	}

	for (let i = 0; i < groupedMessages.length; i++) {
		const item = groupedMessages[i]
		if (Array.isArray(item)) {
			commitToolGroup()
			flushPending()
			result.push(item)
			continue
		}
		const message = item
		const isLast = i === groupedMessages.length - 1

		if (isLowStakesTool(message)) {
			if (!hasTools && pendingReasoning.length > 0) {
				flushPending()
			}
			absorbPending()
			hasTools = true
			toolGroup.push(message)
			if (message.content.type === DiracMessageType.CARD && isLast) {
				pendingTools.push(message)
			}
			continue
		}

		if (message.content.type === DiracMessageType.MARKDOWN && message.content.isReasoning) {
			commitToolGroup()
			flushPending()
			result.push(message)
			continue
		}

		if (message.content.type === DiracMessageType.API_STATUS) {
			if (isApiReqFollowedOnlyByLowStakesTools(i, groupedMessages)) {
				absorbPending()
				pendingApiReq.push(message)
				hasApiReq = true
			} else {
				commitToolGroup()
				flushPending()
				result.push(message)
			}
			continue
		}

		if ((message.content.type === DiracMessageType.CHECKPOINT || (message.content.type === DiracMessageType.CARD && message.content.card.header.includes("Checkpoint"))) && (hasTools || hasApiReq)) {
			toolGroup.push(message)
			continue
		}

		if (message.content.type === DiracMessageType.MARKDOWN && !message.content.isReasoning) {
			commitToolGroup()
			flushPending()
			result.push(message)
			continue
		}

		commitToolGroup()
		flushPending()
		result.push(message)
	}

	commitToolGroup()
	flushPending()
	if (pendingTools.length > 0) {
		result.push(...pendingTools)
	}
	return result
}

/**
 * Check if the chat is currently waiting for a response from the model.
 */
export function getIsWaitingForResponse(
	modifiedMessages: DiracMessage[],
	lastRawMessage: DiracMessage | undefined,
	groupedMessages: (DiracMessage | DiracMessage[])[],
	lastVisibleMessage: DiracMessage | undefined,
	lastVisibleRow: DiracMessage | DiracMessage[] | undefined,
	activeVoiceStreamId?: string,
): boolean {
	const lastMsg = modifiedMessages[modifiedMessages.length - 1]

	// Never show thinking while waiting on user input (any card waiting for input).
	if (lastRawMessage?.content.type === DiracMessageType.CARD && lastRawMessage.content.card.status === CardStatus.WAITING_FOR_INPUT) {
		return false
	}

	if (lastRawMessage?.content.type === DiracMessageType.API_STATUS) {
		const msgContent = lastRawMessage.content
		const info = msgContent.status
		if (info.cancelReason === "user_cancelled") {
			return false
		}
		// If it's an active api_status without cost, we are likely waiting.
		return info.cost == null
	}

	// Always show while task has started but no visible rows are rendered yet.
	if (groupedMessages.length === 0) {
		return true
	}

	// Defensive guard for transient states where a grouped row exists
	if (!lastVisibleMessage) {
		return true
	}

	// Always show when the last rendered row is a toolgroup.
	if (lastVisibleRow && isToolGroup(lastVisibleRow)) {
		return true
	}

	// if the last visible row is not actively partial, always show Thinking in the footer.
	if (lastVisibleMessage.id !== activeVoiceStreamId) {
		return true
	}

	if (!lastMsg) {
		return true
	}

	if (lastMsg.content.type === DiracMessageType.API_STATUS) {
		return lastMsg.content.status.cost == null
	}

	return false
}
