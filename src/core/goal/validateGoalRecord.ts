import type { GoalAccounting, GoalRecord } from "@shared/goal"
import { isActiveGoalStatus } from "@shared/goal"
import { calculateGoalAccounting } from "./GoalAccounting"

type JsonRecord = Record<string, unknown>

const GOAL_STATUSES = new Set(["working", "waiting", "paused", "blocked", "achieved", "stopped"])

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

function nonnegativeNumberAt(value: unknown, path: string): number {
	if (typeof value !== "number" || !Number.isFinite(value) || value < 0) invalid(path, "expected a non-negative finite number")
	return value as number
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
	if (accounting.cost !== undefined) nonnegativeNumberAt(accounting.cost, `${path}.cost`)
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
	if (typeof record.status !== "string" || !GOAL_STATUSES.has(record.status)) {
		invalid(`Goal(${expectedGoalId}).status`, "unsupported value")
	}
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
	if (isActiveGoalStatus(record.status as GoalRecord["status"]) !== (lastActivatedAt !== undefined)) {
		invalid(`Goal(${expectedGoalId}).lastActivatedAt`, "must exist exactly while Goal execution is active")
	}
	if (lastActivatedAt !== undefined && (lastActivatedAt < createdAt || lastActivatedAt > updatedAt)) {
		invalid(`Goal(${expectedGoalId}).lastActivatedAt`, "outside Goal lifetime")
	}
	if (lastPausedAt !== undefined && (lastPausedAt < createdAt || lastPausedAt > updatedAt)) {
		invalid(`Goal(${expectedGoalId}).lastPausedAt`, "outside Goal lifetime")
	}
}
