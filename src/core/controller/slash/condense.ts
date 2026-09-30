import { Empty, StringRequest } from "@shared/proto/dirac/common"
import { DiracAskResponse } from "../../../shared/WebviewMessage"
import { Controller } from ".."

/**
 * Command slash command logic
 */
export async function condense(controller: Controller, _request: StringRequest): Promise<Empty> {
	const cardId = controller.task?.stateView.lastWaitingCardId
	if (cardId && controller.task) {
		await controller.task.submitCardResponse(cardId, DiracAskResponse.APPROVE)
	}
	return Empty.create()
}
