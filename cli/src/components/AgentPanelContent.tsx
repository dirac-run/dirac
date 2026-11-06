import { DiracMessage, DiracMessageType, SubagentExecutionStatus, TaskStatus } from "@shared/ExtensionMessage"
import { formatSubagentTrajectory, readSubagentCardData, type SubagentCardData } from "@shared/subagents"
import { getSubagentUsage } from "@shared/subagentUsage"
import { getTaskletUsage } from "@shared/taskletUsage"
import {
	readTaskletPresentation,
	type TaskletPresentationData,
	type TaskletPresentationStatus,
} from "@shared/taskletPresentation"
import { Box, Text, useInput } from "ink"
import React, { useEffect, useMemo, useState } from "react"
import { theme } from "../constants/theme"
import { useStdinContext } from "../context/StdinContext"
import { useTerminalSize } from "../hooks/useTerminalSize"
import { shouldIgnoreTerminalInput } from "../utils/input"
import { getVisibleWindow } from "../utils/slash-commands"
import { clipTextToWindow, estimateVisualLineCount } from "../utils/text-clipping"
import { Panel } from "./Panel"

interface AgentPanelContentProps {
	messages: DiracMessage[]
	availableRows?: number
	taskStatus?: TaskStatus
	onClose: () => void
}

interface AgentListItem {
	id: number | string
	name: string
	taskTitle?: string
	status: SubagentExecutionStatus | TaskStatus.IDLE | TaskletPresentationStatus
	prompt: string
	transcript: string
}

export const AgentPanelContent: React.FC<AgentPanelContentProps> = ({ messages, availableRows, taskStatus, onClose }) => {
	const { isRawModeSupported } = useStdinContext()
	const { columns, rows } = useTerminalSize()
	const panelRows = availableRows ?? rows
	const [selectedIndex, setSelectedIndex] = useState(0)
	const [openAgentId, setOpenAgentId] = useState<number | string>()
	const [scrollOffset, setScrollOffset] = useState(0)
	const agents = useMemo(() => buildAgentList(messages, taskStatus), [messages, taskStatus])
	const openAgent = agents.find((agent) => agent.id === openAgentId)
	const contentColumns = Math.max(1, columns - 6)
	const contentRows = Math.max(1, panelRows - 5)
	const maxScrollOffset = openAgent
		? Math.max(0, estimateVisualLineCount(openAgent.transcript, contentColumns) - contentRows)
		: 0
	const { items: visibleAgents, startIndex } = getVisibleWindow(agents, selectedIndex, getAgentListRowLimit(panelRows))
	const hasMoreAbove = startIndex > 0
	const hasMoreBelow = startIndex + visibleAgents.length < agents.length

	useEffect(() => {
		setSelectedIndex((current) => Math.max(0, Math.min(current, agents.length - 1)))
	}, [agents.length])

	useEffect(() => {
		setScrollOffset(0)
	}, [openAgentId])

	useInput(
		(input, key) => {
			if (shouldIgnoreTerminalInput(input, key)) return
			if (key.escape) {
				if (openAgentId !== undefined) setOpenAgentId(undefined)
				else onClose()
				return
			}
			if (openAgent) {
				if (key.upArrow) setScrollOffset((current) => Math.min(maxScrollOffset, current + 1))
				if (key.downArrow) setScrollOffset((current) => Math.max(0, current - 1))
				if (key.pageUp) setScrollOffset((current) => Math.min(maxScrollOffset, current + contentRows))
				if (key.pageDown) setScrollOffset((current) => Math.max(0, current - contentRows))
				return
			}
			if (key.upArrow) setSelectedIndex((current) => Math.max(0, current - 1))
			if (key.downArrow) setSelectedIndex((current) => Math.min(agents.length - 1, current + 1))
			if ((key.return || key.tab) && agents[selectedIndex]) setOpenAgentId(agents[selectedIndex].id)
		},
		{ isActive: isRawModeSupported },
	)

	if (openAgent) {
		return (
			<Panel isSubpage label={formatAgentLabel(openAgent, Math.max(1, columns - 21))}>
				<Text color={theme.muted}>{openAgent.status} · ↑/↓ scroll · Esc back</Text>
				<Text>{clipTextToWindow(openAgent.transcript, contentRows, contentColumns, scrollOffset).visibleText}</Text>
			</Panel>
		)
	}

	return (
		<Panel label="Agents">
			<Box flexDirection="column">
				{hasMoreAbove && <Text color={theme.muted}> ▲ earlier agents</Text>}
				{visibleAgents.map((agent, index) => {
					const globalIndex = startIndex + index
					const statusLabel = String(agent.status)
					const labelColumns = Math.max(1, contentColumns - statusLabel.length - 3)
					return (
						<Box flexDirection="column" key={agent.id}>
							<Text
								bold={selectedIndex === globalIndex}
								color={selectedIndex === globalIndex ? theme.primary : theme.text}
								wrap="truncate">
								{selectedIndex === globalIndex ? "❯ " : "  "}
								{formatAgentLabel(agent, labelColumns)} · {statusLabel}
							</Text>
							<Text color={theme.muted} wrap="truncate">
								{" "}
								{oneLinePreview(agent.prompt, columns)}
							</Text>
						</Box>
					)
				})}
				{hasMoreBelow && <Text color={theme.muted}> ▼ later agents</Text>}
				<Text color={theme.muted}>
					{visibleAgents.length} visible · {agents.length} total · Enter inspect · Esc close
				</Text>
			</Box>
		</Panel>
	)
}

export function buildAgentList(messages: DiracMessage[], taskStatus?: TaskStatus): AgentListItem[] {
	const userRole: NonNullable<Extract<DiracMessage["content"], { type: DiracMessageType.MARKDOWN }>["role"]> = "user"
	const mainPrompt = messages.find(
		(message) => message.content.type === DiracMessageType.MARKDOWN && message.content.role === userRole,
	)
	const subagents = messages
		.filter((message) => message.content.type === DiracMessageType.CARD)
		.map((message) => readSubagentCardData(message.content.type === DiracMessageType.CARD ? message.content.card : undefined))
		.filter((agent): agent is SubagentCardData => agent !== undefined)
		.sort((left, right) => left.id - right.id)
	const tasklets = messages
		.flatMap((message) => {
			if (message.content.type !== DiracMessageType.CARD) return []
			const tasklet = readTaskletPresentation(message.content.card)
			return tasklet ? [tasklet] : []
		})
		.sort((left, right) => left.createdAt - right.createdAt)

	return [
		{
			id: 1,
			name: "Dirac",
			status: mainAgentStatus(taskStatus),
			prompt: mainPrompt?.content.type === DiracMessageType.MARKDOWN ? mainPrompt.content.content : "Main agent",
			transcript: formatMainTranscript(messages),
		},
		...subagents.map((agent) => ({
			id: agent.id,
			name: agent.name,
			taskTitle: agent.taskTitle,
			status: agent.status,
			prompt: agent.prompt,
			transcript: formatSubagentTrajectory(agent),
		})),
		...tasklets.map((tasklet) => ({
			id: tasklet.taskletId,
			name: tasklet.title,
			status: tasklet.status,
			prompt: tasklet.prompt,
			transcript: formatTaskletPreview(tasklet),
		})),
	]
}

export function formatAgentLabel(agent: Pick<AgentListItem, "name" | "taskTitle">, maxLength?: number): string {
	const label = agent.taskTitle ? `${agent.name}: ${agent.taskTitle}` : agent.name
	if (maxLength === undefined || label.length <= maxLength) return label
	if (maxLength === 1) return "…"
	return `${label.slice(0, maxLength - 1)}…`
}

export function getAgentListRowLimit(rows: number): number {
	return Math.max(1, Math.floor((rows - 8) / 2))
}

function formatMainTranscript(messages: DiracMessage[]): string {
	const userRole: NonNullable<Extract<DiracMessage["content"], { type: DiracMessageType.MARKDOWN }>["role"]> = "user"
	return (
		messages
			.flatMap((message) => {
				if (message.content.type === DiracMessageType.MARKDOWN) {
					if (message.content.agentId !== undefined) return []
					const speaker = message.content.role === userRole ? "User" : "Dirac"
					return [`${speaker}: ${message.content.content}`]
				}
				if (
					message.content.type === DiracMessageType.CARD &&
					!readSubagentCardData(message.content.card) &&
					!readTaskletPresentation(message.content.card) &&
					!getTaskletUsage(message.content.card) &&
					!getSubagentUsage(message.content.card)
				) {
					return [
						`Tool: ${message.content.card.header}${message.content.card.body ? `\n${message.content.card.body}` : ""}`,
					]
				}
				return []
			})
			.join("\n\n") || "No activity yet."
	)
}

function formatTaskletPreview(tasklet: TaskletPresentationData): string {
	return [
		`${tasklet.title} · ${tasklet.status}`,
		`Assignment\n${tasklet.prompt}`,
		tasklet.result === undefined ? undefined : `Result preview\n${tasklet.result}`,
		tasklet.status === "waiting" ? "Waiting for the parent; no user approval is requested here." : undefined,
		tasklet.communications.length ? `Parent-directed communication\n${tasklet.communications.join("\n\n")}` : undefined,
		tasklet.activity.length ? `Diagnostic activity (not parent requests)\n${tasklet.activity.join("\n\n")}` : undefined,
		"Display preview only; the parent can inspect selected calls, results, messages, and child-only excerpts with tasklets.",
	]
		.filter(Boolean)
		.join("\n\n")
}

function mainAgentStatus(status?: TaskStatus): SubagentExecutionStatus | TaskStatus.IDLE {
	if (status === TaskStatus.COMPLETED) return SubagentExecutionStatus.COMPLETED
	if (status === TaskStatus.CANCELLED) return SubagentExecutionStatus.CANCELLED
	if (!status || status === TaskStatus.IDLE) return TaskStatus.IDLE
	return SubagentExecutionStatus.RUNNING
}

function oneLinePreview(prompt: string, columns: number): string {
	const normalized = prompt.replace(/\s+/g, " ").trim()
	const maxLength = Math.max(10, columns - 12)
	return normalized.length > maxLength ? `${normalized.slice(0, maxLength - 1)}…` : normalized
}
