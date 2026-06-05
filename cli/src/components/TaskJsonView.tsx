/**
 * JSON Task view component
 * Outputs task messages as JSON instead of rich styled text
 */

import { Box } from "ink"
import React, { useEffect, useRef } from "react"
import { DiracMessage, DiracMessageType } from "@shared/ExtensionMessage"

import { useTaskContext, useTaskState } from "../context/TaskContext"
import { useCompletionSignals } from "../hooks/useStateSubscriber"
import { originalConsoleLog } from "../utils/console"

interface TaskJsonViewProps {
	taskId?: string
	verbose?: boolean
	onComplete?: () => void
	onError?: () => void
}

/**
 * Output a JSON line to stdout
 */
function outputJson(data: object) {
	originalConsoleLog(JSON.stringify(data))
}

export const TaskJsonView: React.FC<TaskJsonViewProps> = ({ taskId: _taskId, verbose = false, onComplete, onError }) => {
	const state = useTaskState()
	const { isTaskComplete, getCompletionMessage } = useCompletionSignals()
	const { setIsComplete } = useTaskContext()
	// Track outputted messages by timestamp (don't re-output on updates)
	const outputtedMessages = useRef<Set<string>>(new Set())
	const hasOutputtedCompletion = useRef(false)

	// Determine the role for a message
	const getRole = (message: DiracMessage, index: number): "user" | "assistant" | "system" => {
		const { content } = message

		// First text message is the user's task
		if (content.type === DiracMessageType.MARKDOWN && index === 0) {
			return "user"
		}

		// System messages
		if (content.type === DiracMessageType.API_STATUS) {
			return "system"
		}

		// Default: assistant
		return "assistant"
	}

	// Output messages as JSON when they arrive
	useEffect(() => {
		const messages = state.diracMessages || []

		for (let i = 0; i < messages.length; i++) {
			const message = messages[i]

			// Skip partial messages - wait for complete message
			// Skip partial markdown messages - wait for complete message
			if (state.activeVoiceStreamId === message.id && message.content.type === DiracMessageType.MARKDOWN) {
				continue
			}

			// Skip if we already outputted this timestamp
			if (outputtedMessages.current.has(message.id)) {
				continue
			}

			// Filter out noisy messages in non-verbose mode
			if (!verbose) {
				if (message.content.type === DiracMessageType.API_STATUS) {
					outputtedMessages.current.add(message.id)
					continue
				}
			}

			const role = getRole(message, i)

			// Output the message as JSON
			const output: any = {
				type: "message",
				timestamp: message.ts,
				role,
				messageType: message.content.type,
			}

			if (message.content.type === DiracMessageType.MARKDOWN) {
				output.text = message.content.content
				if (message.content.isReasoning) output.reasoning = true
				if (message.content.images) output.images = message.content.images
				if (message.content.files) output.files = message.content.files
			} else if (message.content.type === DiracMessageType.CARD) {
				output.card = message.content.card
			} else if (message.content.type === DiracMessageType.API_STATUS) {
				output.status = message.content.status
			}

			outputJson(output)

			outputtedMessages.current.add(message.id)
		}
	}, [state.diracMessages, verbose])

	// Handle task completion
	useEffect(() => {
		if (isTaskComplete() && !hasOutputtedCompletion.current) {
			hasOutputtedCompletion.current = true
			setIsComplete(true)

			const completionMsg = getCompletionMessage()
			const isError = completionMsg?.content.type === DiracMessageType.CARD && completionMsg.content.card.status === "error"

			// Output completion status
			outputJson({
				type: "completion",
				status: isError ? "error" : "success",
				timestamp: Date.now(),
			})

			if (isError) {
				onError?.()
			} else {
				onComplete?.()
			}

			// Don't exit automatically - let the parent handle cleanup
		}
	}, [isTaskComplete, setIsComplete, onComplete, onError, getCompletionMessage])

	// Render nothing visible - all output goes to stdout as JSON
	return <Box />
}
