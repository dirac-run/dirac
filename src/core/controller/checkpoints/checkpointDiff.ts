import { Empty, Int64Request } from "@shared/proto/dirac/common"
import { Controller } from ".."

export async function checkpointDiff(controller: Controller, request: Int64Request): Promise<Empty> {
	if (request.value && controller.task) {
		const message = controller.task.messageStateHandler.getDiracMessages().find((m) => m.ts === request.value)
		if (message) {
			await controller.task.checkpointManager?.presentMultifileDiff?.(message.id, false)
		}
	}
	return Empty.create()
}
