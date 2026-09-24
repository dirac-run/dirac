import { StringRequest } from "@shared/proto/dirac/common"
import { DiracAskResponse } from "@shared/WebviewMessage"
import { useApp } from "ink"
import React, { useCallback, useEffect, useState } from "react"
import { showTaskWithId } from "@/core/controller/task/showTaskWithId"
import { telemetryService } from "@/services/telemetry"
import { Logger } from "@/shared/services/Logger"
import { Session } from "@/shared/services/Session"
import { setTerminalTitle } from "../utils/display"
import { shutdownEvent } from "../utils/shutdown"

interface UseChatTaskProps {
	ctrl: any
	taskId?: string
	initialPrompt?: string
	initialImages?: string[]
	resetComposerInput: () => void
	onExit?: () => void
	onError?: () => void
	onInteractionError?: (context: string, error: unknown) => void
	clearState: () => void
	setTaskSwitchKey: React.Dispatch<React.SetStateAction<number>>
}

export function useChatTask({
	ctrl,
	taskId,
	initialPrompt,
	initialImages,
	resetComposerInput,
	onExit,
	onError,
	onInteractionError,
	clearState,
	setTaskSwitchKey,
}: UseChatTaskProps) {
	const { exit: inkExit } = useApp()
	const [isProcessing, setIsProcessing] = useState(false)
	const [isExiting, setIsExiting] = useState(false)
	const exitRequestedRef = React.useRef(false)
	const startupRequestRef = React.useRef({ taskId, initialPrompt, initialImages })
	const startupStartedRef = React.useRef(false)

	const reportError = useCallback(
		(context: string, error: unknown) => {
			if (onInteractionError) {
				onInteractionError(context, error)
				return
			}
			Logger.error(`${context}:`, error)
			onError?.()
		},
		[onError, onInteractionError],
	)
	const reportErrorRef = React.useRef(reportError)
	reportErrorRef.current = reportError

	// Handle cancel/interrupt
	const handleCancel = useCallback(async () => {
		if (!ctrl || isProcessing) return
		setIsProcessing(true)
		try {
			await ctrl.cancelTask()
		} catch (error) {
			reportError("Failed to cancel task", error)
		} finally {
			setIsProcessing(false)
		}
	}, [ctrl, isProcessing, reportError])

	// Handle exit
	const handleExit = useCallback(() => {
		if (exitRequestedRef.current) return
		exitRequestedRef.current = true
		setIsExiting(true)
		inkExit()
		onExit?.()
	}, [inkExit, onExit])

	// Clear view and reset task
	const clearViewAndResetTask = useCallback(async () => {
		if (ctrl) {
			await ctrl.clearTask()
		}
		process.stdout.write("\x1b[2J\x1b[H")
		setTaskSwitchKey((k) => k + 1)
		clearState()
		resetComposerInput()
		if (ctrl) {
			await ctrl.postStateToWebview()
		}
	}, [ctrl, clearState, resetComposerInput, setTaskSwitchKey])

	// Load the requested task and submit an optional initial follow-up as one
	// ordered startup operation. This prevents a follow-up from being sent to a
	// previously active task while the requested history item is still loading.
	useEffect(() => {
		if (!ctrl || startupStartedRef.current) return
		const startupRequest = startupRequestRef.current
		const hasInitialContent = Boolean(startupRequest.initialPrompt || startupRequest.initialImages?.length)
		if (!startupRequest.taskId && !hasInitialContent) return

		startupStartedRef.current = true
		let cancelled = false
		const start = async () => {
			try {
				if (startupRequest.taskId && ctrl.task?.taskId !== startupRequest.taskId) {
					await showTaskWithId(ctrl, StringRequest.create({ value: startupRequest.taskId }))
				}
				if (cancelled || !hasInitialContent) return

				if (startupRequest.initialPrompt) {
					setTerminalTitle(startupRequest.initialPrompt)
				}

				if (!startupRequest.taskId) {
					await ctrl.initTask(startupRequest.initialPrompt || "", startupRequest.initialImages)
					return
				}

				if (ctrl.task?.taskId !== startupRequest.taskId) {
					throw new Error(`Loaded task does not match requested task ${startupRequest.taskId}`)
				}
				await ctrl.task.submitCardResponse(
					"",
					DiracAskResponse.MESSAGE,
					startupRequest.initialPrompt || "",
					startupRequest.initialImages,
				)
			} catch (error) {
				if (!cancelled) reportErrorRef.current("Failed to initialize task", error)
			}
		}
		void start()
		return () => {
			cancelled = true
		}
	}, [ctrl])

	// Shutdown listener
	useEffect(() => {
		const subscription = shutdownEvent.event(() => {
			const session = Session.get()
			const summary = session.getStats()
			telemetryService.captureHostEvent("exit", JSON.stringify(summary))
			setIsExiting(true)
		})
		return () => subscription.dispose()
	}, [])

	return {
		isProcessing,
		setIsProcessing,
		isExiting,
		handleCancel,
		handleExit,
		clearViewAndResetTask,
	}
}
