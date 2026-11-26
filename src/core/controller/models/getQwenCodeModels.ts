import { getCachedQwenCodeModels } from "@/core/api/providers/qwen-code-models"
import { StringRequest } from "@shared/proto/dirac/common"
import { OpenRouterCompatibleModelInfo } from "@shared/proto/dirac/models"
import { toProtobufModelInfo } from "@shared/proto-conversions/models/typeConversion"
import type { Controller } from "../index"

/** Return only public model metadata from the local Qwen Subscription cache. */
export async function getQwenCodeModels(controller: Controller, request: StringRequest): Promise<OpenRouterCompatibleModelInfo> {
	const path = request.value ?? controller.stateManager.getApiConfiguration().qwenCodeOauthPath
	const models = getCachedQwenCodeModels(path)
	return OpenRouterCompatibleModelInfo.create({
		models: Object.fromEntries(Object.entries(models).map(([id, info]) => [id, toProtobufModelInfo(info)])),
	})
}
