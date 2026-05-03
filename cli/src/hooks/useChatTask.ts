import React, { useCallback, useEffect, useState } from "react"
import { useApp } from "ink"
import { Logger } from "@/shared/services/Logger"
import { telemetryService } from "@/services/telemetry"
import { Session } from "@/shared/services/Session"
import { shutdownEvent } from "../vscode-shim"
import { showTaskWithId } from "@/core/controller/task/showTaskWithId"
import { StringRequest } from "@shared/proto/dirac/common"
import { waitFor } from "../utils/timeout"
import { setTerminalTitle } from "../utils/display"

interface UseChatTaskProps {
	ctrl: any
	taskId?: string
	initialPrompt?: string
	initialImages?: string[]
	storageKey: string
	onExit?: () => void
	onError?: () => void
	clearState: () => void
	setTextInput: (text: string) => void
	setCursorPos: (pos: number | ((prev: number) => number)) => void
	setTaskSwitchKey: React.Dispatch<React.SetStateAction<number>>
}

export function useChatTask({
	ctrl,
	taskId,
	initialPrompt,
	initialImages,
	storageKey,
	onExit,
	onError,
	clearState,
	setTextInput,
	setCursorPos,
	setTaskSwitchKey,
}: UseChatTaskProps) {
	const { exit: inkExit } = useApp()
	const [isProcessing, setIsProcessing] = useState(false)
	const [isExiting, setIsExiting] = useState(false)

	// Handle cancel/interrupt
	const handleCancel = useCallback(async () => {
		if (!ctrl || isProcessing) return
		setIsProcessing(true)
		try {
			await ctrl.cancelTask()
		} catch {
			// Controller may be disposed
		} finally {
			setIsProcessing(false)
		}
	}, [ctrl, isProcessing])

	// Handle exit
	const handleExit = useCallback(() => {
		setIsExiting(true)
		// Delay to allow Ink to re-render with session summary visible
		setTimeout(() => {
			inkExit()
			onExit?.()
		}, 150)
	}, [inkExit, onExit])

	// Clear view and reset task
	const clearViewAndResetTask = useCallback(async () => {
		if (ctrl) {
			await ctrl.clearTask()
		}
		process.stdout.write("\x1b[2J\x1b[H")
		setTaskSwitchKey((k) => k + 1)
		clearState()
		setTextInput("")
		setCursorPos(0)
		if (ctrl) {
			ctrl.postStateToWebview()
		}
	}, [ctrl, clearState, setTextInput, setCursorPos, setTaskSwitchKey])

	// Load existing task
	useEffect(() => {
		if (!taskId || !ctrl || ctrl.task?.taskId === taskId) return
		showTaskWithId(ctrl, StringRequest.create({ value: taskId })).catch((error) => {
			Logger.error(`Error loading task: ${error}`)
			onError?.()
		})
	}, [taskId, ctrl, onError])

	// Auto-submit initial prompt
	useEffect(() => {
		const autoSubmit = async () => {
			if (!initialPrompt && (!initialImages || initialImages.length === 0)) return
			if (!ctrl) return

			await new Promise((resolve) => setTimeout(resolve, 100))

			try {
				if (initialPrompt) {
					setTerminalTitle(initialPrompt)
				}

				if (taskId) {
					const task = await waitFor(() => ctrl.task, 5000)
					if (task) {
						await task.handleWebviewAskResponse("messageResponse", initialPrompt || "")
					} else {
						await ctrl.initTask(initialPrompt || "", initialImages)
					}
				} else {
					await ctrl.initTask(initialPrompt || "", initialImages)
				}
			} catch (error) {
				onError?.()
			}
		}
		autoSubmit()
	}, [])

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
