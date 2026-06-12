export interface ChatLayoutInput {
    terminalRows: number
    hasConversationContent: boolean
    hasActivity: boolean
    hasComposer: boolean
    hasFooter: boolean
    hasPanel: boolean
}

export interface ChatLayoutRows {
    liveViewportRows: number
    activeContentRows: number
    compactHistoryRows: number
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
    activity: 3,
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

export function calculateChatLayoutRows(input: ChatLayoutInput): ChatLayoutRows {
    const availableRows = Math.max(1, input.terminalRows - calculateReservedRows(input))
    const liveViewportRows = input.hasConversationContent
        ? boundedRows(availableRows, ROWS.liveViewport)
        : availableRows
    const activeContentRows = calculateActiveContentRows(liveViewportRows)
    const compactHistoryRows = Math.min(
        liveViewportRows - activeContentRows,
        boundedRows(liveViewportRows, ROWS.compactHistory),
    )

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
        input.hasFooter ? ROWS.footer : 0,
        input.hasActivity ? ROWS.activity : 0,
        ROWS.margin,
    ].reduce((total, rows) => total + rows, 0)
}

function calculateActiveContentRows(liveViewportRows: number): number {
    const availableContentRows = Math.max(
        ROWS.activeContent.min,
        liveViewportRows - ACTIVE_CONTENT_CHROME_ROWS,
    )
    const targetContentRows = boundedRows(liveViewportRows, ROWS.activeContent)

    return Math.min(availableContentRows, targetContentRows)
}

function boundedRows(availableRows: number, bounds: Bounds): number {
    const maximumRows = Math.max(bounds.min, Math.floor(availableRows * bounds.maxRatio))
    const targetRows = Math.floor(availableRows * bounds.targetRatio)

    return clamp(targetRows, bounds.min, maximumRows)
}

function clamp(value: number, min: number, max: number): number {
    return Math.min(Math.max(value, min), max)
}
