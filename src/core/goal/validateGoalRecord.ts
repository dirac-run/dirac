import type { GoalAccounting, GoalChildRecord, GoalEvent, GoalPendingInteraction, GoalRecord } from "@shared/goal"
import { isActiveGoalStatus, isTerminalGoalChildStatus } from "@shared/goal"
import { calculateGoalAccounting } from "./GoalAccounting"

type JsonRecord = Record<string, unknown>

const GOAL_STATUSES = new Set(["working", "waiting", "paused", "blocked", "achieved", "stopped"])
const CHILD_ROLES = new Set(["task", "verification"])
const CHILD_STATUSES = new Set(["starting", "running", "waiting", "completed", "failed", "cancelled", "interrupted"])
const INTERACTION_KINDS = new Set(["approval", "feedback", "action"])
const EVENT_KINDS = new Set(["task_response", "task_interaction", "task_failed", "task_finished", "user_steering"])
const CARD_KINDS = new Set(["generic", "task_completion", "resume_task", "resume_completed_task"])
const CARD_STATUSES = new Set([
	"building",
	"pending",
	"running",
	"success",
	"error",
	"skipped",
	"cancelled",
	"abandoned",
	"waiting_for_input",
])
const RENDER_TYPES = new Set(["text", "markdown", "diff"])
const CLEANUP_STRATEGIES = new Set(["abandon", "success", "error", "keep_running"])
const ACTION_STYLES = new Set(["default", "danger", "secondary"])

function invalid(path: string, message: string): never {
	throw new Error(`Invalid Goal state at ${path}: ${message}`)
}

function recordAt(value: unknown, path: string): JsonRecord {
	if (!value || typeof value !== "object" || Array.isArray(value)) invalid(path, "expected an object")
	const prototype = Object.getPrototypeOf(value)
	if (prototype !== Object.prototype && prototype !== null) invalid(path, "expected a plain object")
	return value as JsonRecord
}

function assertKnownKeys(value: JsonRecord, allowed: readonly string[], path: string): void {
	const allowedKeys = new Set(allowed)
	const unknown = Object.keys(value).find((key) => !allowedKeys.has(key))
	if (unknown) invalid(`${path}.${unknown}`, "unknown field")
}

function stringAt(value: unknown, path: string, allowEmpty = false): string {
	if (typeof value !== "string" || (!allowEmpty && value.length === 0)) invalid(path, "expected a non-empty string")
	return value as string
}

function optionalStringAt(value: unknown, path: string): void {
	if (value !== undefined) stringAt(value, path, true)
}

function booleanAt(value: unknown, path: string): void {
	if (typeof value !== "boolean") invalid(path, "expected a boolean")
}

function optionalBooleanAt(value: unknown, path: string): void {
	if (value !== undefined) booleanAt(value, path)
}

function finiteNumberAt(value: unknown, path: string): number {
	if (typeof value !== "number" || !Number.isFinite(value)) invalid(path, "expected a finite number")
	return value as number
}

function nonnegativeNumberAt(value: unknown, path: string): number {
	const number = finiteNumberAt(value, path)
	if (number < 0) invalid(path, "expected a non-negative number")
	return number
}

function optionalNonnegativeNumberAt(value: unknown, path: string): void {
	if (value !== undefined) nonnegativeNumberAt(value, path)
}

function nonnegativeIntegerAt(value: unknown, path: string): number {
	const number = nonnegativeNumberAt(value, path)
	if (!Number.isInteger(number)) invalid(path, "expected an integer")
	return number
}

function positiveIntegerAt(value: unknown, path: string): number {
	const number = nonnegativeIntegerAt(value, path)
	if (number === 0) invalid(path, "expected a positive integer")
	return number
}

function optionalTimestampAt(value: unknown, path: string): number | undefined {
	return value === undefined ? undefined : nonnegativeNumberAt(value, path)
}

function enumAt(value: unknown, values: ReadonlySet<string>, path: string): string {
	if (typeof value !== "string" || !values.has(value)) invalid(path, "unsupported value")
	return value as string
}

function arrayAt(value: unknown, path: string): unknown[] {
	if (!Array.isArray(value)) invalid(path, "expected an array")
	return value as unknown[]
}

function assertJsonValue(value: unknown, path: string): void {
	if (value === null || typeof value === "string" || typeof value === "boolean") return
	if (typeof value === "number") {
		finiteNumberAt(value, path)
		return
	}
	if (Array.isArray(value)) {
		value.forEach((entry, index) => {
			assertJsonValue(entry, `${path}[${index}]`)
		})
		return
	}
	const object = recordAt(value, path)
	for (const [key, entry] of Object.entries(object)) assertJsonValue(entry, `${path}.${key}`)
}

function validateCard(value: unknown, path: string): void {
	const card = recordAt(value, path)
	assertKnownKeys(
		card,
		[
			"id",
			"kind",
			"header",
			"toolName",
			"icon",
			"status",
			"renderType",
			"body",
			"rawInput",
			"rawOutput",
			"diffs",
			"locations",
			"requireApproval",
			"requireFeedback",
			"feedbackPlaceholder",
			"actions",
			"autoScroll",
			"collapsed",
			"maxHeight",
			"cleanupStrategy",
			"do_not_auto_collapse",
			"startTime",
			"endTime",
			"outcome",
		],
		path,
	)
	stringAt(card.id, `${path}.id`)
	if (card.kind !== undefined) enumAt(card.kind, CARD_KINDS, `${path}.kind`)
	stringAt(card.header, `${path}.header`, true)
	optionalStringAt(card.toolName, `${path}.toolName`)
	optionalStringAt(card.icon, `${path}.icon`)
	enumAt(card.status, CARD_STATUSES, `${path}.status`)
	enumAt(card.renderType, RENDER_TYPES, `${path}.renderType`)
	optionalStringAt(card.body, `${path}.body`)
	if (card.rawInput !== undefined) assertJsonValue(recordAt(card.rawInput, `${path}.rawInput`), `${path}.rawInput`)
	if (card.rawOutput !== undefined) assertJsonValue(recordAt(card.rawOutput, `${path}.rawOutput`), `${path}.rawOutput`)
	if (card.diffs !== undefined) {
		arrayAt(card.diffs, `${path}.diffs`).forEach((entry, index) => {
			const diffPath = `${path}.diffs[${index}]`
			const diff = recordAt(entry, diffPath)
			assertKnownKeys(diff, ["path", "oldText", "newText"], diffPath)
			stringAt(diff.path, `${diffPath}.path`)
			stringAt(diff.oldText, `${diffPath}.oldText`, true)
			stringAt(diff.newText, `${diffPath}.newText`, true)
		})
	}
	if (card.locations !== undefined) {
		arrayAt(card.locations, `${path}.locations`).forEach((entry, index) => {
			const locationPath = `${path}.locations[${index}]`
			const location = recordAt(entry, locationPath)
			assertKnownKeys(location, ["path", "line"], locationPath)
			stringAt(location.path, `${locationPath}.path`)
			if (location.line !== undefined) nonnegativeIntegerAt(location.line, `${locationPath}.line`)
		})
	}
	optionalBooleanAt(card.requireApproval, `${path}.requireApproval`)
	optionalBooleanAt(card.requireFeedback, `${path}.requireFeedback`)
	optionalStringAt(card.feedbackPlaceholder, `${path}.feedbackPlaceholder`)
	if (card.actions !== undefined) {
		arrayAt(card.actions, `${path}.actions`).forEach((entry, index) => {
			const actionPath = `${path}.actions[${index}]`
			const action = recordAt(entry, actionPath)
			assertKnownKeys(action, ["label", "value", "primary", "style", "url"], actionPath)
			stringAt(action.label, `${actionPath}.label`)
			stringAt(action.value, `${actionPath}.value`)
			optionalBooleanAt(action.primary, `${actionPath}.primary`)
			if (action.style !== undefined) enumAt(action.style, ACTION_STYLES, `${actionPath}.style`)
			optionalStringAt(action.url, `${actionPath}.url`)
		})
	}
	optionalBooleanAt(card.autoScroll, `${path}.autoScroll`)
	optionalBooleanAt(card.collapsed, `${path}.collapsed`)
	optionalNonnegativeNumberAt(card.maxHeight, `${path}.maxHeight`)
	if (card.cleanupStrategy !== undefined) enumAt(card.cleanupStrategy, CLEANUP_STRATEGIES, `${path}.cleanupStrategy`)
	optionalBooleanAt(card.do_not_auto_collapse, `${path}.do_not_auto_collapse`)
	optionalTimestampAt(card.startTime, `${path}.startTime`)
	optionalTimestampAt(card.endTime, `${path}.endTime`)
	optionalStringAt(card.outcome, `${path}.outcome`)
}

function validatePendingInteraction(value: unknown, path: string): asserts value is GoalPendingInteraction {
	const interaction = recordAt(value, path)
	assertKnownKeys(interaction, ["id", "kind", "createdAt", "card"], path)
	stringAt(interaction.id, `${path}.id`)
	enumAt(interaction.kind, INTERACTION_KINDS, `${path}.kind`)
	nonnegativeNumberAt(interaction.createdAt, `${path}.createdAt`)
	validateCard(interaction.card, `${path}.card`)
}

function validateChild(value: unknown, path: string, record: GoalRecord): asserts value is GoalChildRecord {
	const child = recordAt(value, path)
	assertKnownKeys(
		child,
		[
			"id",
			"title",
			"role",
			"status",
			"createdAt",
			"startedAt",
			"lastActivityAt",
			"endedAt",
			"terminalSummary",
			"pendingInteraction",
			"deliveredResponseCursor",
		],
		path,
	)
	stringAt(child.id, `${path}.id`)
	stringAt(child.title, `${path}.title`)
	enumAt(child.role, CHILD_ROLES, `${path}.role`)
	const status = enumAt(child.status, CHILD_STATUSES, `${path}.status`)
	const createdAt = nonnegativeNumberAt(child.createdAt, `${path}.createdAt`)
	const startedAt = optionalTimestampAt(child.startedAt, `${path}.startedAt`)
	const lastActivityAt = nonnegativeNumberAt(child.lastActivityAt, `${path}.lastActivityAt`)
	const endedAt = optionalTimestampAt(child.endedAt, `${path}.endedAt`)
	optionalStringAt(child.terminalSummary, `${path}.terminalSummary`)
	if (child.pendingInteraction !== undefined) validatePendingInteraction(child.pendingInteraction, `${path}.pendingInteraction`)
	nonnegativeIntegerAt(child.deliveredResponseCursor, `${path}.deliveredResponseCursor`)

	if (createdAt < record.createdAt || createdAt > record.updatedAt) invalid(`${path}.createdAt`, "outside Goal lifetime")
	if (startedAt !== undefined && (startedAt < createdAt || startedAt > record.updatedAt)) {
		invalid(`${path}.startedAt`, "outside child lifetime")
	}
	if (lastActivityAt < createdAt || lastActivityAt > record.updatedAt)
		invalid(`${path}.lastActivityAt`, "outside child lifetime")
	if (endedAt !== undefined && (endedAt < lastActivityAt || endedAt > record.updatedAt)) {
		invalid(`${path}.endedAt`, "outside child lifetime")
	}
	if (isTerminalGoalChildStatus(status as GoalChildRecord["status"]) !== (endedAt !== undefined)) {
		invalid(`${path}.endedAt`, "must exist exactly for a terminal child")
	}
	if (child.pendingInteraction !== undefined && status !== "waiting") {
		invalid(`${path}.pendingInteraction`, "requires waiting child status")
	}
	if (child.pendingInteraction !== undefined) {
		const interactionCreatedAt = (child.pendingInteraction as GoalPendingInteraction).createdAt
		if (interactionCreatedAt < createdAt || interactionCreatedAt > record.updatedAt) {
			invalid(`${path}.pendingInteraction.createdAt`, "outside child lifetime")
		}
	}
}

export function assertGoalAccounting(value: unknown, path: string): asserts value is GoalAccounting {
	const accounting = recordAt(value, path)
	assertKnownKeys(
		accounting,
		["totalTokens", "inputTokens", "outputTokens", "reasoningTokens", "cacheReadTokens", "cacheWriteTokens", "cost"],
		path,
	)
	for (const tokenField of [
		"totalTokens",
		"inputTokens",
		"outputTokens",
		"reasoningTokens",
		"cacheReadTokens",
		"cacheWriteTokens",
	] as const) {
		if (accounting[tokenField] !== undefined) nonnegativeIntegerAt(accounting[tokenField], `${path}.${tokenField}`)
	}
	optionalNonnegativeNumberAt(accounting.cost, `${path}.cost`)
}

function validateEvent(value: unknown, path: string): asserts value is GoalEvent {
	const event = recordAt(value, path)
	const kind = enumAt(event.kind, EVENT_KINDS, `${path}.kind`)
	const commonKeys = ["kind", "sequence", "occurredAt"]
	if (kind === "user_steering") assertKnownKeys(event, commonKeys, path)
	else if (kind === "task_response") assertKnownKeys(event, [...commonKeys, "taskId", "responseCursor"], path)
	else if (kind === "task_interaction") assertKnownKeys(event, [...commonKeys, "taskId", "interactionId"], path)
	else assertKnownKeys(event, [...commonKeys, "taskId"], path)

	positiveIntegerAt(event.sequence, `${path}.sequence`)
	nonnegativeNumberAt(event.occurredAt, `${path}.occurredAt`)
	if (kind !== "user_steering") stringAt(event.taskId, `${path}.taskId`)
	if (kind === "task_response") nonnegativeIntegerAt(event.responseCursor, `${path}.responseCursor`)
	if (kind === "task_interaction") stringAt(event.interactionId, `${path}.interactionId`)
}

/** Legacy records are ownership evidence only, never executable Goal state. */
export function isLegacyGoalRecord(value: unknown): boolean {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false
	const record = value as JsonRecord
	return record.version === 1 || (record.version === undefined && typeof record.schemaVersion === "number")
}

export function assertGoalRecord(value: unknown, expectedGoalId: string): asserts value is GoalRecord {
	const record = recordAt(value, `Goal(${expectedGoalId})`)
	if (isLegacyGoalRecord(record)) {
		throw new Error(
			`Goal ${expectedGoalId} uses a legacy execution format and cannot be opened or resumed. Create a new Goal with /goal. Existing files have not been changed.`,
		)
	}
	assertKnownKeys(
		record,
		[
			"version",
			"id",
			"conversationUlid",
			"status",
			"statusReason",
			"objective",
			"createdAt",
			"updatedAt",
			"lastActivatedAt",
			"lastPausedAt",
			"activeDurationMs",
			"wakeSequence",
			"lastWakeAt",
			"eventSequence",
			"events",
			"children",
			"accountingSources",
			"accounting",
		],
		`Goal(${expectedGoalId})`,
	)
	if (record.version !== 2) invalid(`Goal(${expectedGoalId}).version`, "unsupported schema version")
	if (stringAt(record.id, `Goal(${expectedGoalId}).id`) !== expectedGoalId) {
		invalid(`Goal(${expectedGoalId}).id`, "does not match its storage identity")
	}
	stringAt(record.conversationUlid, `Goal(${expectedGoalId}).conversationUlid`)
	const status = enumAt(record.status, GOAL_STATUSES, `Goal(${expectedGoalId}).status`)
	optionalStringAt(record.statusReason, `Goal(${expectedGoalId}).statusReason`)
	const objective = recordAt(record.objective, `Goal(${expectedGoalId}).objective`)
	assertKnownKeys(objective, ["markdown", "revision", "updatedAt"], `Goal(${expectedGoalId}).objective`)
	if (!stringAt(objective.markdown, `Goal(${expectedGoalId}).objective.markdown`, true).trim()) {
		invalid(`Goal(${expectedGoalId}).objective.markdown`, "must contain non-whitespace Markdown")
	}
	positiveIntegerAt(objective.revision, `Goal(${expectedGoalId}).objective.revision`)
	const objectiveUpdatedAt = nonnegativeNumberAt(objective.updatedAt, `Goal(${expectedGoalId}).objective.updatedAt`)
	const createdAt = nonnegativeNumberAt(record.createdAt, `Goal(${expectedGoalId}).createdAt`)
	const updatedAt = nonnegativeNumberAt(record.updatedAt, `Goal(${expectedGoalId}).updatedAt`)
	const lastActivatedAt = optionalTimestampAt(record.lastActivatedAt, `Goal(${expectedGoalId}).lastActivatedAt`)
	const lastPausedAt = optionalTimestampAt(record.lastPausedAt, `Goal(${expectedGoalId}).lastPausedAt`)
	nonnegativeNumberAt(record.activeDurationMs, `Goal(${expectedGoalId}).activeDurationMs`)
	const wakeSequence = nonnegativeIntegerAt(record.wakeSequence, `Goal(${expectedGoalId}).wakeSequence`)
	const lastWakeAt = optionalTimestampAt(record.lastWakeAt, `Goal(${expectedGoalId}).lastWakeAt`)
	const eventSequence = nonnegativeIntegerAt(record.eventSequence, `Goal(${expectedGoalId}).eventSequence`)
	const accountingSources = recordAt(record.accountingSources, `Goal(${expectedGoalId}).accountingSources`)
	for (const [sourceId, snapshot] of Object.entries(accountingSources)) {
		if (!sourceId) invalid(`Goal(${expectedGoalId}).accountingSources`, "contains an empty source identity")
		assertGoalAccounting(snapshot, `Goal(${expectedGoalId}).accountingSources.${sourceId}`)
	}
	assertGoalAccounting(record.accounting, `Goal(${expectedGoalId}).accounting`)
	const expectedAccounting = calculateGoalAccounting(accountingSources as Record<string, GoalAccounting>)
	const accounting = record.accounting as GoalAccounting
	const accountingFields: (keyof GoalAccounting)[] = [
		"totalTokens",
		"inputTokens",
		"outputTokens",
		"reasoningTokens",
		"cacheReadTokens",
		"cacheWriteTokens",
		"cost",
	]
	if (accountingFields.some((field) => accounting[field] !== expectedAccounting[field])) {
		invalid(`Goal(${expectedGoalId}).accounting`, "does not match its durable source snapshots")
	}

	if (updatedAt < createdAt) invalid(`Goal(${expectedGoalId}).updatedAt`, "predates creation")
	if (objectiveUpdatedAt < createdAt || objectiveUpdatedAt > updatedAt) {
		invalid(`Goal(${expectedGoalId}).objective.updatedAt`, "outside Goal lifetime")
	}
	if (isActiveGoalStatus(status as GoalRecord["status"]) !== (lastActivatedAt !== undefined)) {
		invalid(`Goal(${expectedGoalId}).lastActivatedAt`, "must exist exactly while Goal execution is active")
	}
	if (lastActivatedAt !== undefined && (lastActivatedAt < createdAt || lastActivatedAt > updatedAt)) {
		invalid(`Goal(${expectedGoalId}).lastActivatedAt`, "outside Goal lifetime")
	}
	if (lastPausedAt !== undefined && (lastPausedAt < createdAt || lastPausedAt > updatedAt)) {
		invalid(`Goal(${expectedGoalId}).lastPausedAt`, "outside Goal lifetime")
	}
	if ((wakeSequence === 0) !== (lastWakeAt === undefined)) {
		invalid(`Goal(${expectedGoalId}).lastWakeAt`, "must exist exactly after the first wake")
	}
	if (lastWakeAt !== undefined && (lastWakeAt < createdAt || lastWakeAt > updatedAt)) {
		invalid(`Goal(${expectedGoalId}).lastWakeAt`, "outside Goal lifetime")
	}

	const typedRecord = record as unknown as GoalRecord
	const childIds = new Set<string>()
	arrayAt(record.children, `Goal(${expectedGoalId}).children`).forEach((child, index) => {
		validateChild(child, `Goal(${expectedGoalId}).children[${index}]`, typedRecord)
		const childId = (child as GoalChildRecord).id
		if (childIds.has(childId)) invalid(`Goal(${expectedGoalId}).children[${index}].id`, "duplicate child identity")
		childIds.add(childId)
	})
	const events = arrayAt(record.events, `Goal(${expectedGoalId}).events`)

	let priorSequence = 0
	events.forEach((event, index) => {
		const eventPath = `Goal(${expectedGoalId}).events[${index}]`
		validateEvent(event, eventPath)
		const typedEvent = event as GoalEvent
		if (typedEvent.sequence <= priorSequence) invalid(`${eventPath}.sequence`, "events are not strictly ordered")
		if (typedEvent.sequence > eventSequence) invalid(`${eventPath}.sequence`, "exceeds eventSequence")
		if (typedEvent.kind !== "user_steering" && !childIds.has(typedEvent.taskId)) {
			invalid(`${eventPath}.taskId`, "does not identify a Goal child")
		}
		if (typedEvent.occurredAt < createdAt || typedEvent.occurredAt > updatedAt) {
			invalid(`${eventPath}.occurredAt`, "outside Goal lifetime")
		}
		priorSequence = typedEvent.sequence
	})
}
