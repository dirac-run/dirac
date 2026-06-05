import { Empty } from "@shared/proto/dirac/common"
import { AskResponseRequest } from "@shared/proto/dirac/task"
import { Logger } from "@/shared/services/Logger"
import { DiracAskResponse } from "../../../shared/WebviewMessage"
import { Controller } from ".."

/**
 * Handles a response from the webview for a previous ask operation
 *
 * @param controller The controller instance
 * @param request The request containing response type, optional text and optional images
 * @returns Empty response
 */
export async function askResponse(controller: Controller, request: AskResponseRequest): Promise<Empty> {
	try {
		if (!controller.task) {
			Logger.warn("askResponse: No active task to receive response")
			return Empty.create()
		}

		// Map the string responseType to the DiracAskResponse enum
		// Map the string responseType to the DiracAskResponse enum
		let responseType: DiracAskResponse | string
		switch (request.responseType) {
			case DiracAskResponse.APPROVE:
			case "yesButtonClicked":
				responseType = DiracAskResponse.APPROVE
				break
			case DiracAskResponse.REJECT:
			case "noButtonClicked":
				responseType = DiracAskResponse.REJECT
				break
			case DiracAskResponse.MESSAGE:
			case "messageResponse":
				responseType = DiracAskResponse.MESSAGE
				break
			case DiracAskResponse.EDIT:
			case "editButtonClicked":
				responseType = DiracAskResponse.EDIT
				break
			case DiracAskResponse.VIEW:
			case "viewButtonClicked":
				responseType = DiracAskResponse.VIEW
				break
			case DiracAskResponse.UNDO:
			case "undoButtonClicked":
				responseType = DiracAskResponse.UNDO
				break
			default:
				// Support custom actions
				responseType = request.responseType
		}

		// Call the task's handler for webview responses using the new submitCardResponse primitive
		await controller.task.submitCardResponse(
			request.cardId,
			responseType,
			request.text,
			request.images,
			request.files,
			request.value,
		)

		return Empty.create()
	} catch (error) {
		Logger.error("Error in askResponse handler:", error)
		throw error
	}
}
