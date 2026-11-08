import type { Controller } from ".."
import { readSavedPresentationHistory } from "@core/storage/conversationHistory"
import { loadTaskletRecord } from "@core/storage/taskStorage"
import { String as StringResponse } from "@shared/proto/dirac/common"
import type { TaskletTranscriptRequest } from "@shared/proto/dirac/task"
import type { TaskletTranscriptPage } from "@shared/taskletObservation"
import {
	OBSERVATION_PAGE_BYTES,
	observationCursor,
	clipObservationText,
	observationFingerprint,
	observationLimit,
	observationOffset,
	observedMessage,
	outcomeObservation,
	savedInventoryRow,
	selectedObservation,
} from "./taskletObservation"
import { savedSettledRecord } from "@core/storage/taskStorage"

/** Bounded, inert human transcript. Reading cannot consume a request or revive saved execution. */
export async function getTaskletTranscript(controller: Controller, request: TaskletTranscriptRequest): Promise<StringResponse> {
	const source = selectedObservation(controller, request.rootTaskId, request.sourceId)
	const limit = observationLimit(request.limit)
	const transcript = source.host
		? await source.host.readObservationTranscript(request.taskletId)
		: await savedTranscript(source.rootTaskId, request.taskletId)
	selectedObservation(controller, source.rootTaskId, source.sourceId)
	const scope = observationFingerprint([source.rootTaskId, source.sourceId, "transcript", request.taskletId])
	const revision = observationFingerprint([
		transcript.presentationGeneration,
		transcript.presentationOffset,
		transcript.state,
		transcript.outcome,
		transcript.presentationRevision,
	])
	const start = observationOffset(request.cursor, scope, revision)
	if (start > transcript.messages.length) throw new Error("Tasklet transcript cursor is beyond the current snapshot")
	const page: TaskletTranscriptPage = {
		rootTaskId: source.rootTaskId,
		sourceId: source.sourceId,
		availability: source.availability,
		observedAt: Date.now(),
		taskletId: request.taskletId,
		title: clipObservationText(transcript.title, 512),
		...(transcript.role === undefined ? {} : { role: transcript.role }),
		state: transcript.state,
		messages: [],
		truncatedMessageIds: [],
		outcome: outcomeObservation(transcript.outcome),
	}
	let offset = start
	let bytes = Buffer.byteLength(JSON.stringify(page))
	while (offset < transcript.messages.length && page.messages.length < limit) {
		const observed = observedMessage(transcript.messages[offset])
		if (!observed) {
			offset++
			continue
		}
		const size = Buffer.byteLength(JSON.stringify(observed.message))
		if (bytes + size > OBSERVATION_PAGE_BYTES - 4096) break
		page.messages.push(observed.message)
		if (observed.truncated) page.truncatedMessageIds.push(observed.message.id)
		bytes += size
		offset++
	}
	if (offset < transcript.messages.length) page.nextCursor = observationCursor(scope, revision, offset)
	return StringResponse.create({ value: JSON.stringify(page) })
}

async function savedTranscript(rootTaskId: string, taskletId: string) {
	const savedRecord = await loadTaskletRecord({ kind: "tasklet", rootTaskId, taskletId })
	const record = await savedSettledRecord(savedRecord)
	const saved = await readSavedPresentationHistory({ kind: "tasklet", rootTaskId, taskletId })
	return {
		...savedInventoryRow(record),
		messages: saved.messages,
		outcome: record.outcome,
		presentationOffset: saved.lastOffset,
		// Legacy histories may have no operation offsets. Fingerprinting only this selected saved child catches replacement.
		presentationGeneration: 0,
		presentationRevision: observationFingerprint(saved.messages),
	}
}
