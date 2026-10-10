import { fetchUnbiasedModels } from "@core/api/unbiased/unbiased-models"
import { EmptyRequest } from "@shared/proto/dirac/common"
import { OpenRouterCompatibleModelInfo } from "@shared/proto/dirac/models"
import { toProtobufModelInfo } from "@shared/proto-conversions/models/typeConversion"
import type { Controller } from "../index"

/** Discover Unbiased models using the effective saved or environment-provided key. */
export async function refreshUnbiasedModelsRpc(
	controller: Controller,
	_request: EmptyRequest,
): Promise<OpenRouterCompatibleModelInfo> {
	const models = await fetchUnbiasedModels(controller.stateManager.getApiConfiguration().unbiasedApiKey)
	return OpenRouterCompatibleModelInfo.create({
		models: Object.fromEntries(
			Object.entries(models).map(([id, info]) => [
				id,
				{
					...toProtobufModelInfo(info),
					name: info.name,
					supportsTools: info.supportsTools,
				},
			]),
		),
	})
}
