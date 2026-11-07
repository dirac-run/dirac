/**
 * React Context for task state management in CLI
 * Provides access to ExtensionState and task controller
 */

import { DiracMessageType, type DiracMessage, type ExtensionState } from "@shared/ExtensionMessage"
import React, { createContext, ReactNode, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react"
import { mergeLocalObservations, type LocalObservationMessage } from "../utils/local-observation"
import { EmptyRequest } from "@shared/proto/dirac/common"
import { subscribeToState } from "@/core/controller/state/subscribeToState"
import { getRequestRegistry } from "@/core/controller/grpc-handler"
import type { PresentationBatch } from "@shared/PresentationOperation"
import { applyPresentationBatch, createPresentationState } from "@shared/presentationState"

let taskContextSubscriptionCounter = 0

interface TaskContextType {
	state: Partial<ExtensionState>
	displayMessages: DiracMessage[]
	observationEpoch: number
	appendLocalObservation: (text: string, epoch: number) => void
	controller: any
	isComplete: boolean
	setIsComplete: (complete: boolean) => void
	lastError: string | null
	setLastError: (error: string | null) => void
	clearState: () => void
}

const TaskContext = createContext<TaskContextType | undefined>(undefined)

interface TaskContextProviderProps {
	controller: any
	children: ReactNode
}

export const TaskContextProvider: React.FC<TaskContextProviderProps> = ({ controller, children }) => {
	const [state, setState] = useState<Partial<ExtensionState>>(
		() =>
			({
				diracMessages: [],
				currentTaskItem: null,
			}) as unknown as Partial<ExtensionState>,
	)
	const [isComplete, setIsComplete] = useState(false)
	const [lastError, setLastError] = useState<string | null>(null)

	// Use ref to track latest state for partial message callback
	const stateRef = useRef(state)
	stateRef.current = state
	const presentationRef = useRef(createPresentationState())
	const [localObservations, setLocalObservations] = useState<LocalObservationMessage[]>([])
	const observationEpochRef = useRef(0)
	const localMessageSequence = useRef(0)
	const displayMessages = useMemo(
		() => mergeLocalObservations(state.diracMessages ?? [], localObservations),
		[state.diracMessages, localObservations],
	)
	const appendLocalObservation = useCallback((text: string, epoch: number) => {
		if (epoch !== observationEpochRef.current) return
		const messages = presentationRef.current.messages
		const message: DiracMessage = {
			id: `local-observation:${++localMessageSequence.current}`,
			ts: Date.now(),
			content: { type: DiracMessageType.MARKDOWN, content: text },
		}
		setLocalObservations((entries) => [
			...entries,
			{ afterMessageId: messages.at(-1)?.id, position: messages.length, message },
		])
	}, [])

	// Subscribe to controller state updates
	useEffect(() => {
		let disposed = false
		const requestId = `cli-task-context-${++taskContextSubscriptionCounter}`
		const receiveStateUpdate = async ({ stateJson, presentationJson }: { stateJson: string; presentationJson?: string }) => {
			try {
				const update = JSON.parse(stateJson) as Partial<ExtensionState>
				let presentationChanged = update.diracMessages !== undefined
				if (disposed) return
				if (update.diracMessages !== undefined) {
					presentationRef.current = createPresentationState(
						update.diracMessages,
						update.presentationSurfaceId,
						update.presentationOffset,
					)
				}
				if (presentationJson) {
					const applied = applyPresentationBatch(
						presentationRef.current,
						JSON.parse(presentationJson) as PresentationBatch,
					)
					presentationChanged ||= applied.result === "applied"
					if (applied.result === "gap") {
						const fullState = (await controller.getStateToPostToWebview()) as ExtensionState
						presentationRef.current = createPresentationState(
							fullState.diracMessages,
							fullState.presentationSurfaceId,
							fullState.presentationOffset,
						)
						Object.assign(update, fullState)
						presentationChanged = true
					}
				}
				const surfaceChanged = presentationRef.current.surfaceId !== stateRef.current.presentationSurfaceId
				const sourceChanged =
					"taskletActivity" in update && update.taskletActivity?.sourceId !== stateRef.current.taskletActivity?.sourceId
				if (surfaceChanged || sourceChanged) observationEpochRef.current++
				if (surfaceChanged) setLocalObservations([])
				const nextState: Partial<ExtensionState> = {
					...stateRef.current,
					...update,
					diracMessages: presentationChanged
						? [...presentationRef.current.messages]
						: (stateRef.current.diracMessages ?? presentationRef.current.messages),
					presentationSurfaceId: presentationRef.current.surfaceId,
					presentationOffset: presentationRef.current.offset,
					activeVoiceStreamId: update.activeVoiceStreamId,
				}
				stateRef.current = nextState
				setState(nextState)
			} catch (error) {
				if (!disposed) setLastError(error instanceof Error ? error.message : String(error))
			}
		}

		void subscribeToState(controller, EmptyRequest.create(), receiveStateUpdate, requestId).then(
			() => {
				if (disposed) getRequestRegistry().cancelRequest(requestId)
			},
			(error) => {
				if (!disposed) setLastError(error instanceof Error ? error.message : String(error))
			},
		)

		return () => {
			disposed = true
			getRequestRegistry().cancelRequest(requestId)
		}
	}, [controller])

	// Force clear state (bypasses the empty messages check for intentional clears like /clear)
	const clearState = () => {
		observationEpochRef.current++
		setLocalObservations([])
		const clearedState = {
			diracMessages: [],
			currentTaskItem: null,
		} as unknown as Partial<ExtensionState>
		presentationRef.current = createPresentationState()
		stateRef.current = clearedState
		setState(clearedState)
	}

	const value: TaskContextType = {
		state,
		displayMessages,
		observationEpoch: observationEpochRef.current,
		appendLocalObservation,
		controller,
		isComplete,
		setIsComplete,
		lastError,
		setLastError,
		clearState,
	}

	return <TaskContext.Provider value={value}>{children}</TaskContext.Provider>
}

/**
 * Hook to access task context
 */
export const useTaskContext = (): TaskContextType => {
	const context = useContext(TaskContext)
	if (!context) {
		throw new Error("useTaskContext must be used within TaskContextProvider")
	}
	return context
}

/**
 * Hook to access task state only
 */
export const useTaskState = (): Partial<ExtensionState> => {
	const { state } = useTaskContext()
	return state
}

/**
 * Hook to access controller
 */
export const useTaskController = () => {
	const { controller } = useTaskContext()
	return controller
}
