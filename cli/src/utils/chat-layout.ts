export interface ChatLayoutInput {
	terminalRows: number
	hasConversationContent: boolean
	hasComposer: boolean
	hasFooter: boolean
	hasPanel: boolean
	footerRows?: number
	goalSummaryRows?: number
}

export interface ChatLayoutRows {
	liveViewportRows: number
	activeContentRows: number
	compactHistoryRows: number
}

export interface PermissionModalLayout {
	width: number
	height: number
	bodyLines: number
	bodyColumns: number
}

interface Bounds {
	min: number
	targetRatio: number
	maxRatio: number
}

const MIN_ACTIVE_CONTENT_ROWS = 3
const ACTIVE_CONTENT_CHROME_ROWS = 4
const MIN_LIVE_VIEWPORT_ROWS = MIN_ACTIVE_CONTENT_ROWS + ACTIVE_CONTENT_CHROME_ROWS

const ROWS = {
	composer: 3,
	footer: 4,
	panel: 10,
	margin: 2,
	liveViewport: {
		min: MIN_LIVE_VIEWPORT_ROWS,
		targetRatio: 0.55,
		maxRatio: 0.7,
	},
	activeContent: {
		min: MIN_ACTIVE_CONTENT_ROWS,
		targetRatio: 0.8,
		maxRatio: 1,
	},
	compactHistory: {
		min: 0,
		targetRatio: 0.2,
		maxRatio: 0.3,
	},
} as const

const GOAL_SUMMARY_COMPACT_ROWS = 5
const GOAL_SUMMARY_EXPANDED_ROWS = 9
const GOAL_FOOTER_ROWS = 2
const MIN_SHORT_TERMINAL_TRANSCRIPT_ROWS = 2
const MIN_VISIBLE_TRANSCRIPT_ROWS = 1
const MIN_GOAL_SUMMARY_ROWS = 1
const MIN_TERMINAL_ROWS_FOR_GOAL_FOOTER = 10

export function shouldShowGoalFooter(terminalRows: number): boolean {
	return terminalRows >= MIN_TERMINAL_ROWS_FOR_GOAL_FOOTER
}

export function calculateGoalSummaryRows(terminalRows: number, detailsExpanded: boolean): number {
	const footerRows = shouldShowGoalFooter(terminalRows) ? GOAL_FOOTER_ROWS : 0
	const compactRows = clamp(
		terminalRows - ROWS.composer - footerRows - MIN_VISIBLE_TRANSCRIPT_ROWS,
		MIN_GOAL_SUMMARY_ROWS,
		GOAL_SUMMARY_COMPACT_ROWS,
	)
	if (!detailsExpanded) return compactRows

	const rowsAvailableWithoutCrowdingTranscript =
		terminalRows - ROWS.composer - footerRows - ROWS.margin - MIN_SHORT_TERMINAL_TRANSCRIPT_ROWS
	return clamp(rowsAvailableWithoutCrowdingTranscript, compactRows, GOAL_SUMMARY_EXPANDED_ROWS)
}

export function calculateChatLayoutRows(input: ChatLayoutInput): ChatLayoutRows {
	const availableRows = Math.max(1, input.terminalRows - calculateReservedRows(input))
	const liveViewportRows = input.hasConversationContent ? boundedRows(availableRows, ROWS.liveViewport) : availableRows
	const activeContentRows = calculateActiveContentRows(liveViewportRows)
	const compactHistoryRows = Math.min(liveViewportRows - activeContentRows, boundedRows(liveViewportRows, ROWS.compactHistory))

	return {
		liveViewportRows,
		activeContentRows,
		compactHistoryRows: Math.max(0, compactHistoryRows),
	}
}

function calculateReservedRows(input: ChatLayoutInput): number {
	if (input.hasPanel) return ROWS.panel + ROWS.margin

	return [
		input.hasComposer ? ROWS.composer : 0,
		input.hasFooter ? (input.footerRows ?? ROWS.footer) : 0,
		input.goalSummaryRows ?? 0,
		ROWS.margin,
	].reduce((total, rows) => total + rows, 0)
}

function calculateActiveContentRows(liveViewportRows: number): number {
	const availableContentRows = Math.max(1, liveViewportRows - ACTIVE_CONTENT_CHROME_ROWS)
	const targetContentRows = boundedRows(liveViewportRows, ROWS.activeContent)

	return Math.min(availableContentRows, targetContentRows)
}

function boundedRows(availableRows: number, bounds: Bounds): number {
	const safeAvailableRows = Math.max(1, availableRows)
	const minimumRows = Math.min(bounds.min, safeAvailableRows)
	const maximumRows = Math.max(minimumRows, Math.min(safeAvailableRows, Math.floor(safeAvailableRows * bounds.maxRatio)))
	const targetRows = Math.floor(safeAvailableRows * bounds.targetRatio)

	return clamp(targetRows, minimumRows, maximumRows)
}

function clamp(value: number, min: number, max: number): number {
	return Math.min(Math.max(value, min), max)
}

export function calculatePermissionModalLayout(terminalColumns: number, terminalRows: number): PermissionModalLayout {
	const columns = Math.max(1, terminalColumns)
	const rows = Math.max(1, terminalRows)
	const availableWidth = Math.max(1, columns - 2)
	const desiredWidth = Math.max(1, Math.floor(columns * 0.8))
	const width = Math.min(availableWidth, desiredWidth)
	const height = Math.max(1, Math.min(32, rows - 4))

	return {
		width,
		height,
		bodyLines: Math.max(1, height - 7),
		bodyColumns: Math.max(1, width - 6),
	}
}
