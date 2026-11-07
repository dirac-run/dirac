/**
 * Prints finalized, displaced snapshots exactly once through Ink's <Static>.
 * Revisable items can return to the live tail without rewriting terminal history.
 * A caller's revisable snapshots need not be mutable archival barriers; only active root output/input is.
 */
import { useRef } from "react"

export interface TranscriptPartition<T> {
	/** Immutable snapshots, appended only after leaving the live viewport. */
	staticPrefix: T[]
	/** Uncommitted items from which the bounded live viewport is projected. */
	dynamicTail: T[]
}

interface TranscriptRetention<T> {
	rowBudget: number
	estimateRows: (message: T) => number
}

export interface TranscriptRevisions<T> {
	key: (message: T) => string
	/** Only changed revisions of committed items re-enter the live tail. */
	revision: (message: T) => unknown
}

export function useTranscriptPartition<T>(
	messages: T[],
	isMutable: (message: T) => boolean,
	conversationKey?: string,
	retention?: TranscriptRetention<T>,
	revisions?: TranscriptRevisions<T>,
): TranscriptPartition<T> {
	const stateRef = useRef({
		conversationKey,
		staticPrefix: [] as T[],
		committed: new Map<string | number, unknown>(),
		tailKeys: [] as Array<string | number>,
		dynamicTail: [] as T[],
	})
	if (stateRef.current.conversationKey !== conversationKey) {
		stateRef.current = { conversationKey, staticPrefix: [], committed: new Map(), tailKeys: [], dynamicTail: [] }
	}
	const state = stateRef.current
	const current = new Map(messages.map((message, index) => [revisions?.key(message) ?? index, message]))
	state.tailKeys = state.tailKeys.filter((key) => current.has(key))
	const pendingKeys = new Set(state.tailKeys)
	for (const [key, message] of current) {
		if (pendingKeys.has(key)) continue
		if (state.committed.has(key) && Object.is(state.committed.get(key), revisions?.revision(message))) continue
		// Revisions must not displace active output/input behind an archival barrier.
		const mutableIndex = state.committed.has(key)
			? state.tailKeys.findIndex((tailKey) => isMutable(current.get(tailKey)!))
			: -1
		if (mutableIndex === -1) state.tailKeys.push(key)
		else state.tailKeys.splice(mutableIndex, 0, key)
		pendingKeys.add(key)
	}
	const tail = state.tailKeys.map((key) => current.get(key)!)
	const target = calculateTargetWatermark(tail, isMutable, retention)
	if (target > 0) {
		const snapshots = tail.slice(0, target)
		for (let index = 0; index < target; index++) {
			state.committed.set(state.tailKeys[index], revisions?.revision(snapshots[index]))
		}
		state.staticPrefix = [...state.staticPrefix, ...snapshots]
		state.tailKeys = state.tailKeys.slice(target)
	}
	const dynamicTail = tail.slice(target)
	if (!sameItems(dynamicTail, state.dynamicTail)) state.dynamicTail = dynamicTail
	return { staticPrefix: state.staticPrefix, dynamicTail: state.dynamicTail }
}

function calculateTargetWatermark<T>(
	messages: T[],
	isMutable: (message: T) => boolean,
	retention?: TranscriptRetention<T>,
): number {
	const firstMutableIndex = messages.findIndex(isMutable)
	const mutableBoundary = firstMutableIndex === -1 ? messages.length : firstMutableIndex
	if (!retention) return mutableBoundary

	const visibleBoundary = calculateVisibleBoundary(messages, retention.rowBudget, retention.estimateRows)
	return Math.min(mutableBoundary, visibleBoundary)
}

export function calculateVisibleBoundary<T>(messages: T[], rowBudget: number, estimateRows: (message: T) => number): number {
	if (messages.length === 0) return 0

	let remainingRows = Math.max(1, rowBudget)
	for (let index = messages.length - 1; index >= 0; index--) {
		const messageRows = Math.max(1, estimateRows(messages[index]))
		if (messageRows >= remainingRows) return index
		remainingRows -= messageRows
	}

	return 0
}

function sameItems<T>(left: T[], right: T[]): boolean {
	return left.length === right.length && left.every((item, index) => item === right[index])
}
