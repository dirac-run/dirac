import { useEffect, useMemo, useRef, useState } from "react"
import { combineCommandSequences } from "@shared/combineCommandSequences"
import { combineHookSequences } from "@shared/combineHookSequences"
import { isFileEditTool, parseToolFromMessage } from "../utils/tools"

export function useChatMessages(messages: any[]) {
	const [taskSwitchKey, setTaskSwitchKey] = useState(0)
	const prevFirstMessageTs = useRef<number | null>(null)

	const displayMessages = useMemo(() => {
		const filtered = messages.filter((m) => {
			if (m.say === "api_req_finished") return false
			if (m.say === "checkpoint_created") return false
			if (m.say === "api_req_started") return false
			if (m.say === "api_req_retried") return false
			if (m.say === "reasoning") return false
			return true
		})
		const withHooks = combineHookSequences(filtered)
		return combineCommandSequences(withHooks)
	}, [messages])

	const firstMessageTs = displayMessages[0]?.ts ?? null
	useEffect(() => {
		if (prevFirstMessageTs.current !== null && firstMessageTs !== null && prevFirstMessageTs.current !== firstMessageTs) {
			process.stdout.write("\x1b[2J\x1b[H")
			setTaskSwitchKey((k) => k + 1)
		}
		prevFirstMessageTs.current = firstMessageTs
	}, [firstMessageTs])

	const { completedMessages, currentMessage } = useMemo(() => {
		const completed: any[] = []
		let current: any = null
		const skipDynamicTypes = new Set(["completion_result", "plan_mode_respond"])

		const isUnselectedFollowup = (msg: any) => {
			if (msg.type === "ask" && msg.ask === "followup" && msg.text) {
				try {
					const parsed = JSON.parse(msg.text)
					return parsed.options && parsed.options.length > 0 && !parsed.selected
				} catch {
					return false
				}
			}
			return false
		}

		const isFileEditToolMessage = (msg: any) => {
			if ((msg.say === "tool" || msg.ask === "tool") && msg.text) {
				const toolInfo = parseToolFromMessage(msg.text)
				return toolInfo ? isFileEditTool(toolInfo.toolName) : false
			}
			return false
		}

		const shouldCommandStayInDynamic = (msg: any, isLast: boolean) => {
			const isCommand = msg.ask === "command" || msg.say === "command"
			if (!isCommand) return false
			if (!msg.commandCompleted) return true
			const hasOutput = msg.text?.includes("Output:") ?? false
			if (!hasOutput && isLast) return true
			return false
		}

		for (let i = 0; i < displayMessages.length; i++) {
			const msg = displayMessages[i]
			const isLast = i === displayMessages.length - 1
			const shouldSkipDynamic =
				skipDynamicTypes.has(msg.say || "") ||
				(msg.type === "ask" && skipDynamicTypes.has(msg.ask || "")) ||
				isFileEditToolMessage(msg)

			if (msg.partial) {
				if (isLast && !shouldSkipDynamic) {
					current = msg
				}
			} else if (isLast && isUnselectedFollowup(msg)) {
				current = msg
			} else if (shouldCommandStayInDynamic(msg, isLast)) {
				if (isLast) {
					current = msg
				}
			} else {
				completed.push(msg)
			}
		}
		return { completedMessages: completed, currentMessage: current }
	}, [displayMessages])

	return {
		displayMessages,
		completedMessages,
		currentMessage,
		taskSwitchKey,
		setTaskSwitchKey,
	}
}
