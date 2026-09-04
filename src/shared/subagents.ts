import { Card, CardStatus, DiracMessage, DiracMessageType, SubagentExecutionStatus } from "./ExtensionMessage"

export const SUBAGENT_NAMES = [
	"Feynman",
	"Planck",
	"Bohr",
	"Heisenberg",
	"Curie",
	"Shannon",
	"Maxwell",
	"Gödel",
	"Euler",
	"Tao",
	"Hawking",
	"Pauli",
	"Noether",
	"Ramanujan",
	"Turing",
	"Faraday",
	"Gauss",
	"Newton",
	"Einstein",
	"Descartes",
	"von Neumann",
	"Schrödinger",
	"Witten",
	"Fermi",
	"Boltzmann",
	"Riemann",
	"Hilbert",
	"Poincaré",
	"Lagrange",
	"Laplace",
	"Faraday",
	"Kolmogorov",
] as const

export const SUBAGENT_TRAJECTORY_MAX_EVENTS = 80
export const SUBAGENT_TRAJECTORY_EVENT_MAX_CHARS = 1200

export interface SubagentIdentity {
	id: number
	name: string
}

export enum SubagentTrajectoryEventType {
	MESSAGE = "message",
	TOOL = "tool",
	TOOL_RESULT = "tool_result",
	RESULT = "result",
	ERROR = "error",
}

export interface SubagentTrajectoryEvent {
	type: SubagentTrajectoryEventType
	text: string
}

/** Display-only run totals; accounting remains in the separate usage record. */
export interface SubagentCardUsage {
	inputTokens: number
	outputTokens: number
	cacheReadTokens: number
	cacheWriteTokens: number
	totalCost: number
}

export interface SubagentCardData extends SubagentIdentity {
	taskTitle?: string
	prompt: string
	status: SubagentExecutionStatus
	trajectory: SubagentTrajectoryEvent[]
	usage?: SubagentCardUsage
}

interface SubagentProgressEvent {
	status?: SubagentExecutionStatus
	result?: string
	error?: string
	trajectoryEvent?: SubagentTrajectoryEvent
}

export function allocateSubagentIdentity(messages: DiracMessage[], reserved: SubagentIdentity[] = []): SubagentIdentity {
	const existing = messages
		.filter((message) => message.content.type === DiracMessageType.CARD)
		.map((message) => readSubagentCardData(message.content.type === DiracMessageType.CARD ? message.content.card : undefined))
		.filter((agent): agent is SubagentCardData => agent !== undefined)
	const identities = [...existing, ...reserved]
	const usedNames = new Set(identities.map((agent) => agent.name))
	const name = allocateUniqueSubagentName(usedNames)
	const id = identities.reduce((highest, agent) => Math.max(highest, agent.id), 1) + 1
	return { id, name }
}

function allocateUniqueSubagentName(usedNames: Set<string>): string {
	const availableNames = SUBAGENT_NAMES.filter((name) => !usedNames.has(name))
	if (availableNames.length > 0) return availableNames[Math.floor(Math.random() * availableNames.length)]

	for (const firstName of SUBAGENT_NAMES) {
		for (const secondName of SUBAGENT_NAMES) {
			const compoundName = `${firstName} ${secondName}`
			if (!usedNames.has(compoundName)) return compoundName
		}
	}

	throw new Error("Subagent name pool exhausted")
}

export function createSubagentCardInput(identity: SubagentIdentity, prompt: string, taskTitle?: string): Record<string, unknown> {
	return {
		isSubagent: true,
		agentId: identity.id,
		agentName: identity.name,
		...(taskTitle === undefined ? {} : { taskTitle }),
		prompt,
	}
}

export const SUBAGENT_TASK_TITLE_MAX_WORDS = 5
export const SUBAGENT_TASK_TITLE_MAX_CHARS = 80

export function createSubagentCardOutput(
	status: SubagentExecutionStatus,
	trajectory: SubagentTrajectoryEvent[],
	usage?: SubagentCardUsage,
): Record<string, unknown> {
	return {
		status,
		trajectory: trajectory
			.slice(-SUBAGENT_TRAJECTORY_MAX_EVENTS)
			.map((event) => createSubagentTrajectoryEvent(event.type, event.text)),
		...(usage
			? {
					usage: {
						inputTokens: usage.inputTokens,
						outputTokens: usage.outputTokens,
						cacheReadTokens: usage.cacheReadTokens,
						cacheWriteTokens: usage.cacheWriteTokens,
						totalCost: usage.totalCost,
					},
				}
			: {}),
	}
}

export function createSubagentTrajectoryEvent(type: SubagentTrajectoryEventType, text: string): SubagentTrajectoryEvent {
	return { type, text: truncateTrajectoryText(text) }
}

export function appendSubagentTrajectoryEvent(trajectory: SubagentTrajectoryEvent[], event: SubagentTrajectoryEvent): void {
	trajectory.push(createSubagentTrajectoryEvent(event.type, event.text))
	const overflow = trajectory.length - SUBAGENT_TRAJECTORY_MAX_EVENTS
	if (overflow > 0) trajectory.splice(0, overflow)
}

export function recordSubagentProgress(
	trajectory: SubagentTrajectoryEvent[],
	update: SubagentProgressEvent,
): SubagentExecutionStatus {
	if (update.trajectoryEvent) appendSubagentTrajectoryEvent(trajectory, update.trajectoryEvent)
	if (update.status === SubagentExecutionStatus.COMPLETED && update.result) {
		appendUniqueTerminalEvent(trajectory, SubagentTrajectoryEventType.RESULT, update.result)
	}
	if (
		(update.status === SubagentExecutionStatus.FAILED || update.status === SubagentExecutionStatus.CANCELLED) &&
		update.error
	) {
		appendUniqueTerminalEvent(trajectory, SubagentTrajectoryEventType.ERROR, update.error)
	}
	return update.status ?? SubagentExecutionStatus.RUNNING
}

function appendUniqueTerminalEvent(
	trajectory: SubagentTrajectoryEvent[],
	type: SubagentTrajectoryEventType.RESULT | SubagentTrajectoryEventType.ERROR,
	text: string,
): void {
	const lastEvent = trajectory.at(-1)
	if (lastEvent?.type === type && lastEvent.text === text) return
	appendSubagentTrajectoryEvent(trajectory, { type, text })
}

export function subagentCardStatus(status: SubagentExecutionStatus): CardStatus {
	if (status === SubagentExecutionStatus.COMPLETED) return CardStatus.SUCCESS
	if (status === SubagentExecutionStatus.FAILED) return CardStatus.ERROR
	if (status === SubagentExecutionStatus.CANCELLED) return CardStatus.CANCELLED
	if (status === SubagentExecutionStatus.PENDING) return CardStatus.PENDING
	return CardStatus.RUNNING
}

export function isTerminalSubagentStatus(status: SubagentExecutionStatus): boolean {
	return (
		status === SubagentExecutionStatus.COMPLETED ||
		status === SubagentExecutionStatus.FAILED ||
		status === SubagentExecutionStatus.CANCELLED
	)
}

export function readSubagentCardData(card: Card | undefined): SubagentCardData | undefined {
	if (!card?.rawInput?.isSubagent) return undefined
	const input = card.rawInput
	const id = input.agentId
	const name = input.agentName
	const taskTitle = typeof input.taskTitle === "string" ? input.taskTitle : undefined
	const prompt = input.prompt
	if (typeof id !== "number" || typeof name !== "string" || typeof prompt !== "string") return undefined

	const output = card.rawOutput
	const status = readStatus(output?.status, card.status)
	const trajectory = Array.isArray(output?.trajectory) ? output.trajectory.filter(isTrajectoryEvent) : []
	return { id, name, taskTitle, prompt, status, trajectory, usage: output?.usage as SubagentCardUsage | undefined }
}

export interface SubagentTrajectoryFormatOptions {
	maxLineLength?: number
	includeToolResults?: boolean
}

export function formatSubagentTrajectory(data: SubagentCardData, options: number | SubagentTrajectoryFormatOptions = {}): string {
	const maxLineLength = typeof options === "number" ? options : (options.maxLineLength ?? 180)
	const includeToolResults = typeof options === "number" ? true : (options.includeToolResults ?? true)
	const line = (value: string) => truncateLine(value.replace(/\s+/g, " ").trim(), maxLineLength)
	const activity = data.trajectory.flatMap((event) => {
		switch (event.type) {
			case SubagentTrajectoryEventType.MESSAGE:
				return [`- **${data.name}:** ${line(event.text)}`]
			case SubagentTrajectoryEventType.TOOL:
				return [`- 🔧 \`${line(event.text)}\``]
			case SubagentTrajectoryEventType.TOOL_RESULT:
				return includeToolResults ? [`  - ↳ ${line(event.text)}`] : []
			case SubagentTrajectoryEventType.RESULT:
				return [`- ✓ ${line(event.text)}`]
			case SubagentTrajectoryEventType.ERROR:
				return [`- ❌ ${line(event.text)}`]
		}
	})

	return [
		`**${data.name}** · ${data.status}`,
		"",
		"**Prompt**",
		line(data.prompt),
		"",
		"**Trajectory**",
		...(activity.length > 0
			? activity
			: [isTerminalSubagentStatus(data.status) ? "- No trajectory events were recorded." : "- Waiting to start…"]),
	]
		.map((renderedLine) => truncateLine(renderedLine, maxLineLength))
		.concat(isTerminalSubagentStatus(data.status) && data.usage ? ["", formatSubagentUsage(data.usage)] : [])
		.join("\n")
}

function formatSubagentUsage(usage: SubagentCardUsage): string {
	return [
		`Input: ${usage.inputTokens.toLocaleString("en-US")}`,
		`Output: ${usage.outputTokens.toLocaleString("en-US")}`,
		`Cache read: ${usage.cacheReadTokens.toLocaleString("en-US")}`,
		`Cache write: ${usage.cacheWriteTokens.toLocaleString("en-US")}`,
		`Cost: $${usage.totalCost.toFixed(4)}`,
	].join(" · ")
}

function isTrajectoryEvent(value: unknown): value is SubagentTrajectoryEvent {
	if (!value || typeof value !== "object") return false
	const event = value as Partial<SubagentTrajectoryEvent>
	return (
		typeof event.text === "string" &&
		(event.type === SubagentTrajectoryEventType.MESSAGE ||
			event.type === SubagentTrajectoryEventType.TOOL ||
			event.type === SubagentTrajectoryEventType.TOOL_RESULT ||
			event.type === SubagentTrajectoryEventType.RESULT ||
			event.type === SubagentTrajectoryEventType.ERROR)
	)
}

function readStatus(value: unknown, cardStatus: CardStatus): SubagentExecutionStatus {
	if (cardStatus === CardStatus.SUCCESS) return SubagentExecutionStatus.COMPLETED
	if (cardStatus === CardStatus.CANCELLED || cardStatus === CardStatus.ABANDONED) return SubagentExecutionStatus.CANCELLED
	if (cardStatus === CardStatus.ERROR) return SubagentExecutionStatus.FAILED
	if (Object.values(SubagentExecutionStatus).includes(value as SubagentExecutionStatus)) {
		return value as SubagentExecutionStatus
	}
	if (cardStatus === CardStatus.PENDING) return SubagentExecutionStatus.PENDING
	return SubagentExecutionStatus.RUNNING
}

function truncateTrajectoryText(value: string): string {
	if (value.length <= SUBAGENT_TRAJECTORY_EVENT_MAX_CHARS) return value
	return `${value.slice(0, SUBAGENT_TRAJECTORY_EVENT_MAX_CHARS - 1)}…`
}

function truncateLine(value: string, maxLength: number): string {
	if (value.length <= maxLength) return value
	return `${value.slice(0, Math.max(0, maxLength - 1))}…`
}
