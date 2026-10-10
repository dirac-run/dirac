import path from "node:path"
import { ensureCacheDirectoryExists, GlobalFileNames } from "@core/storage/disk"
import { fetchUnbiasedModels } from "@core/api/unbiased/unbiased-models"
import { EmptyRequest } from "@shared/proto/dirac/common"
import { OpenRouterCompatibleModelInfo } from "@shared/proto/dirac/models"
import { toProtobufModelInfo } from "@shared/proto-conversions/models/typeConversion"
import { fileExistsAtPath } from "@utils/fs"
import { getAxiosSettings } from "@/shared/net"
import type { Controller } from "../index"

/** Discover Unbiased models using the effective saved or environment-provided key. */
export async function refreshUnbiasedModelsRpc(
	controller: Controller,
	_request: EmptyRequest,
): Promise<OpenRouterCompatibleModelInfo> {
	const stateManager = controller.stateManager
	const models = await fetchUnbiasedModels(stateManager.getApiConfiguration().unbiasedApiKey, {
		cache: stateManager,
		cacheFilePath: async () => path.join(await ensureCacheDirectoryExists(), GlobalFileNames.unbiasedModels),
		fileExists: fileExistsAtPath,
		axiosSettings: getAxiosSettings(),
	})
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
