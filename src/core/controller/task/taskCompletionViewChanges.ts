import { Empty, StringRequest } from "@shared/proto/dirac/common"
import { Logger } from "@/shared/services/Logger"
import { Controller } from ".."
import { DiracMessageType } from "@shared/ExtensionMessage"
import { findLast } from "@shared/array"

/**
 * Shows task completion changes in a diff view
 * @param controller The controller instance
 * @param request The request containing the card ID of the completion
 * @returns Empty response
 */
export async function taskCompletionViewChanges(controller: Controller, request: StringRequest): Promise<Empty> {
	try {
		if (request.value && controller.task) {
			const messages = controller.task.messageStateHandler.getDiracMessages()
			const message = findLast(
				messages,
				(m) => m.content.type === DiracMessageType.CARD && m.content.card.id === request.value,
			)
			if (message) {
				await controller.task.checkpointManager?.presentMultifileDiff?.(message.id, true)
			}
		}
		return Empty.create()
	} catch (error) {
		Logger.error("Error in taskCompletionViewChanges handler:", error)
		throw error
	}
}
