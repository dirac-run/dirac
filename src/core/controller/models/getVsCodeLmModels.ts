import { EmptyRequest } from "@shared/proto/dirac/common"
import { VsCodeLmModelsArray } from "@shared/proto/dirac/models"
import { HostProvider } from "@/hosts/host-provider"
import { Logger } from "@/shared/services/Logger"
import { convertVsCodeNativeModelsToProtoModels } from "../../../shared/proto-conversions/models/vscode-lm-models-conversion"
import { Controller } from ".."

/**
 * Fetches available models from VS Code LM API
 * @param controller The controller instance
 * @param request Empty request
 * @returns Array of VS Code LM models
 */
export async function getVsCodeLmModels(_controller: Controller, _request: EmptyRequest): Promise<VsCodeLmModelsArray> {
	try {
		// Only the VS Code host provides a language-model API; other hosts return an empty list.
		const models = (await HostProvider.get().capabilities.listVsCodeLmModels?.()) ?? []

		const protoModels = convertVsCodeNativeModelsToProtoModels(models)

		return VsCodeLmModelsArray.create({ models: protoModels })
	} catch (error) {
		Logger.error("Error fetching VS Code LM models:", error)
		return VsCodeLmModelsArray.create({ models: [] })
	}
}
