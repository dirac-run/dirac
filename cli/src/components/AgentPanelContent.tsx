import type { Controller } from "@/core/controller"
import { getTaskletInventory } from "@/core/controller/task/getTaskletInventory"
import { getTaskletTranscript } from "@/core/controller/task/getTaskletTranscript"
import { TaskletInventoryRequest, TaskletTranscriptRequest } from "@shared/proto/dirac/task"
import {
	TASKLET_STATE_LABELS,
	type TaskletActivitySummary,
	type TaskletInventoryPage,
	type TaskletTranscriptPage,
} from "@shared/taskletObservation"
import { Box, Text, useInput } from "ink"
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react"
import stringWidth from "string-width"
import { theme } from "../constants/theme"
import { useStdinContext } from "../context/StdinContext"
import { useTerminalSize } from "../hooks/useTerminalSize"
import { shouldIgnoreTerminalInput } from "../utils/input"
import { formatAgentTranscript } from "../utils/local-observation"
import { getVisibleWindow } from "../utils/slash-commands"
import { clipTextToWindow, estimateVisualLineCount } from "../utils/text-clipping"
import { Panel } from "./Panel"

interface AgentPanelContentProps {
	controller: Controller
	scope?: TaskletActivitySummary | null
	availableRows?: number
	onClose: () => void
}

/** Passive, bounded reads only. There are deliberately no card controls or child input handlers. */
export const AgentPanelContent: React.FC<AgentPanelContentProps> = ({ controller, scope, availableRows, onClose }) => {
	const { isRawModeSupported } = useStdinContext()
	const { columns, rows } = useTerminalSize()
	const rootTaskId = scope?.rootTaskId
	const sourceId = scope?.sourceId
	const [inventory, setInventory] = useState<TaskletInventoryPage>()
	const [transcript, setTranscript] = useState<TaskletTranscriptPage>()
	const [selectedIndex, setSelectedIndex] = useState(0)
	const [openAgentId, setOpenAgentId] = useState<string>()
	const [scrollFromTop, setScrollFromTop] = useState(0)
	const [error, setError] = useState<string>()
	const [loading, setLoading] = useState(false)
	const [inventoryCursor, setInventoryCursor] = useState<string>()
	const [transcriptCursor, setTranscriptCursor] = useState<string>()
	const [inventoryPrevious, setInventoryPrevious] = useState<Array<string | undefined>>([])
	const [transcriptPrevious, setTranscriptPrevious] = useState<Array<string | undefined>>([])
	const requestSequence = useRef(0)
	const selectedSource = useRef({ rootTaskId, sourceId })
	selectedSource.current = { rootTaskId, sourceId }

	const readPage = useCallback(
		async (taskletId?: string, cursor?: string) => {
			const request = ++requestSequence.current
			if (!rootTaskId || !sourceId) return
			setLoading(true)
			setError(undefined)
			try {
				const response = taskletId
					? await getTaskletTranscript(
						controller,
						TaskletTranscriptRequest.create({ rootTaskId, sourceId, taskletId, cursor, limit: 20 }),
					)
					: await getTaskletInventory(
						controller,
						TaskletInventoryRequest.create({ rootTaskId, sourceId, filter: "all", cursor, limit: 50 }),
					)
				if (
					request !== requestSequence.current ||
					selectedSource.current.rootTaskId !== rootTaskId ||
					selectedSource.current.sourceId !== sourceId
				)
					return
				const page = JSON.parse(response.value) as TaskletInventoryPage | TaskletTranscriptPage
				if (page.rootTaskId !== rootTaskId || page.sourceId !== sourceId)
					throw new Error("Agent observation source changed. Refresh the panel.")
				if (taskletId) {
					setTranscript(page as TaskletTranscriptPage)
					setTranscriptCursor(cursor)
					setScrollFromTop(0)
				} else {
					setInventory(page as TaskletInventoryPage)
					setInventoryCursor(cursor)
					setSelectedIndex(0)
				}
			} catch (cause) {
				if (
					request === requestSequence.current &&
					selectedSource.current.rootTaskId === rootTaskId &&
					selectedSource.current.sourceId === sourceId
				)
					setError(cause instanceof Error ? cause.message : String(cause))
			} finally {
				if (request === requestSequence.current) setLoading(false)
			}
		},
		[controller, rootTaskId, sourceId],
	)

	useEffect(() => {
		setInventory(undefined)
		setTranscript(undefined)
		setOpenAgentId(undefined)
		setInventoryCursor(undefined)
		setInventoryPrevious([])
		setTranscriptPrevious([])
		setError(undefined)
		setLoading(false)
		void readPage()
		return () => {
			requestSequence.current++
		}
	}, [readPage])

	const panelRows = availableRows ?? rows
	const contentColumns = Math.max(1, columns - 6)
	const contentRows = Math.max(1, panelRows - 6)
	const transcriptText = useMemo(() => (transcript ? formatAgentTranscript(transcript) : ""), [transcript])
	const maxScrollOffset = Math.max(0, estimateVisualLineCount(transcriptText, contentColumns) - contentRows)
	const agents = inventory?.items ?? []
	const { items: visibleAgents, startIndex } = getVisibleWindow(agents, selectedIndex, getAgentListRowLimit(panelRows))
	const page = openAgentId ? transcript : inventory
	const previous = openAgentId ? transcriptPrevious : inventoryPrevious

	useInput(
		(input, key) => {
			if (shouldIgnoreTerminalInput(input, key)) return
			if (key.escape) {
				requestSequence.current++
				setLoading(false)
				setError(undefined)
				if (openAgentId) {
					setOpenAgentId(undefined)
					setTranscript(undefined)
					setTranscriptPrevious([])
				} else onClose()
				return
			}
			if (loading) return
			if (input === "r") {
				if (openAgentId) setTranscriptPrevious([])
				else setInventoryPrevious([])
				void readPage(openAgentId)
				return
			}
			if (input === "n" && page?.nextCursor) {
				if (openAgentId) setTranscriptPrevious((entries) => [...entries, transcriptCursor])
				else setInventoryPrevious((entries) => [...entries, inventoryCursor])
				void readPage(openAgentId, page.nextCursor)
				return
			}
			if (input === "p" && previous.length) {
				if (openAgentId) setTranscriptPrevious((entries) => entries.slice(0, -1))
				else setInventoryPrevious((entries) => entries.slice(0, -1))
				void readPage(openAgentId, previous.at(-1))
				return
			}
			if (openAgentId) {
				if (key.upArrow) setScrollFromTop((current) => Math.max(0, current - 1))
				if (key.downArrow) setScrollFromTop((current) => Math.min(maxScrollOffset, current + 1))
				if (key.pageUp) setScrollFromTop((current) => Math.max(0, current - contentRows))
				if (key.pageDown) setScrollFromTop((current) => Math.min(maxScrollOffset, current + contentRows))
				return
			}
			if (key.upArrow) setSelectedIndex((current) => Math.max(0, current - 1))
			if (key.downArrow) setSelectedIndex((current) => Math.min(agents.length - 1, current + 1))
			if ((key.return || key.tab) && agents[selectedIndex]) {
				const id = agents[selectedIndex].taskletId
				setOpenAgentId(id)
				setTranscript(undefined)
				setTranscriptCursor(undefined)
				setTranscriptPrevious([])
				void readPage(id)
			}
		},
		{ isActive: isRawModeSupported },
	)

	return (
		<Panel
			isSubpage={!!openAgentId}
			label={
				openAgentId
					? clipAgentTitle(transcript?.title ?? "Agent transcript", columns - 4 - stringWidth(" (Esc to go back)"))
					: "Agents · read only"
			}>
			<Text color={theme.muted} wrap="truncate">
				{page?.availability === "saved" ? "Saved history" : "Recorded snapshot"}
				{page ? ` · ${new Date(page.observedAt).toLocaleTimeString()}` : ""}
				{transcript && openAgentId ? ` · ${TASKLET_STATE_LABELS[transcript.state]}` : ""}
			</Text>
			{!rootTaskId && <Text>No task selected.</Text>}
			{loading && <Text color={theme.muted}>Reading…</Text>}
			{error && <Text color={theme.error}>{error} · r refresh</Text>}
			{!loading && !error && openAgentId && transcript && (
				<Text>
					{
						clipTextToWindow(
							transcriptText,
							contentRows,
							contentColumns,
							Math.max(0, maxScrollOffset - scrollFromTop),
						).visibleText
					}
				</Text>
			)}
			{!loading && !error && !openAgentId && inventory && (
				<Box flexDirection="column">
					{agents.length === 0 && <Text>No recorded agents.</Text>}
					{visibleAgents.map((agent, index) => (
						<Text
							key={agent.taskletId}
							color={selectedIndex === startIndex + index ? theme.primary : theme.text}
							wrap="truncate">
							{selectedIndex === startIndex + index ? "❯ " : "  "}
							{clipAgentTitle(agent.title, contentColumns - 3 - stringWidth(TASKLET_STATE_LABELS[agent.state]))} ·{" "}
							{TASKLET_STATE_LABELS[agent.state]}
						</Text>
					))}
					<Text color={theme.muted}>
						{inventory.totalItems} total
						{visibleAgents.length > 0 ? ` · ${startIndex + 1}–${startIndex + visibleAgents.length} on this page` : ""}
					</Text>
				</Box>
			)}
			<Text color={theme.muted} wrap="truncate">
				{openAgentId ? "↑/↓ scroll" : "↑/↓ select · Enter inspect"} · r refresh{page?.nextCursor ? " · n next" : ""}
				{previous.length ? " · p previous" : ""} · Esc {openAgentId ? "back" : "close"}
			</Text>
		</Panel>
	)
}

function clipAgentTitle(title: string, width: number): string {
	const normalized = title.replace(/\s+/g, " ").trim()
	if (width <= 0) return ""
	if (stringWidth(normalized) <= width) return normalized
	let clipped = ""
	for (const character of normalized) {
		if (stringWidth(`${clipped}${character}…`) > width) break
		clipped += character
	}
	return `${clipped}…`
}

export function getAgentListRowLimit(rows: number): number {
	return Math.max(1, rows - 7)
}
