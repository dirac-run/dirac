import { Empty } from "@shared/proto/dirac/common"
import { UpdateApiConfigurationRequest } from "@shared/proto/dirac/models"
import { convertProtoToApiConfiguration } from "@shared/proto-conversions/models/api-configuration-conversion"
import { buildApiHandler } from "@/core/api"
import { recordSavedOpenAiCompatibleProfileChanges } from "@/core/models/modelProviderPresets"
import { Logger } from "@/shared/services/Logger"
import type { Controller } from "../index"

/**
 * Updates API configuration
 * @param controller The controller instance
 * @param request The update API configuration request
 * @returns Empty response
 */
export async function updateApiConfigurationProto(
	controller: Controller,
	request: UpdateApiConfigurationRequest,
): Promise<Empty> {
	try {
		if (!request.apiConfiguration) {
			Logger.log("[APICONFIG: updateApiConfigurationProto] API configuration is required")
			throw new Error("API configuration is required")
		}

		const protoApiConfiguration = request.apiConfiguration

		const convertedApiConfigurationFromProto = convertProtoToApiConfiguration(protoApiConfiguration)

		const previousProfiles = controller.stateManager.getApiConfiguration().openAiCompatibleProfiles || []

		// Update the API configuration in storage
		controller.stateManager.setApiConfiguration(convertedApiConfigurationFromProto)
		recordSavedOpenAiCompatibleProfileChanges(controller.stateManager, previousProfiles)

		// Update the task's API handler if there's an active task
		if (controller.task) {
			const currentMode = controller.stateManager.getGlobalSettingsKey("mode")
			controller.task.api = buildApiHandler(
				{ ...convertedApiConfigurationFromProto, ulid: controller.task.ulid },
				currentMode,
			)
		}

		// Post updated state to webview
		await controller.postStateToWebview()

		return Empty.create()
	} catch (error) {
		Logger.error(`Failed to update API configuration: ${error}`)
		throw error
	}
}
