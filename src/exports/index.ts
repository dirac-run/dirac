import { Controller } from "@core/controller"
import { sendChatButtonClickedEvent } from "@core/controller/ui/subscribeToChatButtonClicked"
import { Logger } from "@/shared/services/Logger"
import { DiracAskResponse } from "../shared/WebviewMessage"

import { DiracAPI } from "./dirac"

export function createDiracAPI(sidebarController: Controller): DiracAPI {
	const api: DiracAPI = {
		startNewTask: async (task?: string, images?: string[]) => {
			await sidebarController.clearTask()
			await sidebarController.postStateToWebview()

			await sendChatButtonClickedEvent()
			await sidebarController.initTask(task, images)
		},

		sendMessage: async (message?: string, images?: string[]) => {
			if (sidebarController.task) {
				await sidebarController.task.submitCardResponse("", DiracAskResponse.MESSAGE, message || "", images || [])
			} else {
				Logger.error("No active task to send message to")
			}
		},

		pressPrimaryButton: async () => {
			if (sidebarController.task) {
				await sidebarController.task.submitCardResponse("", DiracAskResponse.APPROVE)
			} else {
				Logger.error("No active task to press button for")
			}
		},

		pressSecondaryButton: async () => {
			if (sidebarController.task) {
				await sidebarController.task.submitCardResponse("", DiracAskResponse.REJECT)
			} else {
				Logger.error("No active task to press button for")
			}
		},
	}

	return api
}
