import fs from "node:fs"
import path from "node:path"
import type * as acp from "@agentclientprotocol/sdk"
import { DIRAC_CLI_DIR } from "../utils/path.js"

const SESSION_UPDATES_FILE = path.join(DIRAC_CLI_DIR.data, "acp-session-updates.json")
const SEQUENCE_META_KEY = "dev.dirac/seq"

type SessionUpdateWithMeta = acp.SessionUpdate & { _meta?: Record<string, unknown> }

export type PersistedSessionUpdate =
	| {
			kind: "session_update"
			sequenceNumber: number
			update: SessionUpdateWithMeta
		}
	| {
			kind: "usage_update"
			sequenceNumber: number
			usage: Record<string, unknown>
		}
	| {
			kind: "client_annotation"
			sequenceNumber: number
			annotation: Record<string, unknown>
		}

type SessionUpdatesMap = Record<string, PersistedSessionUpdate[]>

function readSessionUpdatesMap(): SessionUpdatesMap {
	if (!fs.existsSync(SESSION_UPDATES_FILE)) {
		return {}
	}

	return JSON.parse(fs.readFileSync(SESSION_UPDATES_FILE, "utf-8")) as SessionUpdatesMap
}

function writeSessionUpdatesMap(map: SessionUpdatesMap): void {
	fs.mkdirSync(path.dirname(SESSION_UPDATES_FILE), { recursive: true })
	fs.writeFileSync(SESSION_UPDATES_FILE, JSON.stringify(map, null, 2))
}

function nextSequenceNumber(updates: PersistedSessionUpdate[]): number {
	return (updates.at(-1)?.sequenceNumber ?? 0) + 1
}

/** Persist one ACP session update with its stable, per-session sequence number. */
export function recordSessionUpdate(sessionId: string, update: acp.SessionUpdate): SessionUpdateWithMeta {
	const map = readSessionUpdatesMap()
	const updates = map[sessionId] ?? []
	const sequenceNumber = nextSequenceNumber(updates)
	const updateWithSequence: SessionUpdateWithMeta = {
		...update,
		_meta: {
			...(update as SessionUpdateWithMeta)._meta,
			[SEQUENCE_META_KEY]: sequenceNumber,
		},
	}

	map[sessionId] = [...updates, { kind: "session_update", sequenceNumber, update: updateWithSequence }]
	writeSessionUpdatesMap(map)
	return updateWithSequence
}

/** Persist one Dirac usage extension update with its stable, per-session sequence number. */
export function recordUsageUpdate(sessionId: string, usage: Record<string, unknown>): Record<string, unknown> {
	const map = readSessionUpdatesMap()
	const updates = map[sessionId] ?? []
	const sequenceNumber = nextSequenceNumber(updates)
	const usageWithSequence = {
		...usage,
		_meta: {
			...(usage._meta as Record<string, unknown> | undefined),
			[SEQUENCE_META_KEY]: sequenceNumber,
		},
	}

	map[sessionId] = [...updates, { kind: "usage_update", sequenceNumber, usage: usageWithSequence }]
	writeSessionUpdatesMap(map)
	return usageWithSequence
}


/** Persist one client control-plane annotation with its stable, per-session sequence number. */
export function recordClientAnnotation(sessionId: string, annotation: Record<string, unknown>): Record<string, unknown> {
	const map = readSessionUpdatesMap()
	const updates = map[sessionId] ?? []
	const sequenceNumber = nextSequenceNumber(updates)
	const annotationWithSequence = {
		...annotation,
		_meta: {
			...(annotation._meta as Record<string, unknown> | undefined),
			[SEQUENCE_META_KEY]: sequenceNumber,
		},
	}

	map[sessionId] = [...updates, { kind: "client_annotation", sequenceNumber, annotation: annotationWithSequence }]
	writeSessionUpdatesMap(map)
	return annotationWithSequence
}

/** Return the immutable ordered ACP update journal for a persisted session. */
export function getSessionUpdates(sessionId: string): PersistedSessionUpdate[] {
	return readSessionUpdatesMap()[sessionId] ?? []
}

/** Remove the complete ACP update journal for a deleted session. */
export function deleteSessionUpdates(sessionId: string): void {
	const map = readSessionUpdatesMap()
	delete map[sessionId]
	writeSessionUpdatesMap(map)
}
