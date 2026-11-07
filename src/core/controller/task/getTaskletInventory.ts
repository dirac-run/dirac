import type { Controller } from ".."
import { loadTaskletRecords, savedSettledRecord } from "@core/storage/taskStorage"
import { String as StringResponse } from "@shared/proto/dirac/common"
import type { TaskletInventoryRequest } from "@shared/proto/dirac/task"
import type { TaskletInventoryPage } from "@shared/taskletObservation"
import {
	observationCursor,
	clipObservationText,
	observationFingerprint,
	observationLimit,
	observationOffset,
	savedInventoryRow,
	selectedObservation,
} from "./taskletObservation"

/** Passive UI inventory. No execution, event delivery, or transcript projection. */
export async function getTaskletInventory(controller: Controller, request: TaskletInventoryRequest): Promise<StringResponse> {
	const source = selectedObservation(controller, request.rootTaskId, request.sourceId)
	const filter = request.filter || "active"
	if (filter !== "active" && filter !== "all") throw new Error("Tasklet inventory filter must be active or all")
	const limit = observationLimit(request.limit)
	const rows = source.host
		? source.host.observationInventory(filter).map((row) => ({ ...row, title: clipObservationText(row.title, 512) }))
		: filter === "active"
			? []
			: (await Promise.all((await loadTaskletRecords(source.rootTaskId)).map(savedSettledRecord))).map(savedInventoryRow)
	selectedObservation(controller, source.rootTaskId, source.sourceId)
	rows.sort((a, b) => a.taskletId.localeCompare(b.taskletId))
	const scope = observationFingerprint([source.rootTaskId, source.sourceId, "inventory", filter])
	const revision = observationFingerprint(rows)
	const offset = observationOffset(request.cursor, scope, revision)
	if (offset > rows.length) throw new Error("Tasklet inventory cursor is beyond the current snapshot")
	const end = Math.min(rows.length, offset + limit)
	const page: TaskletInventoryPage = {
		rootTaskId: source.rootTaskId,
		sourceId: source.sourceId,
		availability: source.availability,
		observedAt: Date.now(),
		filter,
		items: rows.slice(offset, end),
		totalItems: rows.length,
		...(end < rows.length ? { nextCursor: observationCursor(scope, revision, end) } : {}),
	}
	return StringResponse.create({ value: JSON.stringify(page) })
}
