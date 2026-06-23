import type { ModelInfo } from "@shared/api"
import { Empty, EmptyRequest } from "@shared/proto/dirac/common"
import { OpenRouterCompatibleModelInfo } from "@shared/proto/dirac/models"
import { telemetryService } from "@/services/telemetry"
import { Logger } from "@/shared/services/Logger"
import { GlobalStateAndSettings } from "@/shared/storage/state-keys"
import type { Controller } from "../index"
import { refreshBasetenModels } from "../models/refreshBasetenModels"
import { refreshGithubCopilotModels } from "../models/refreshGithubCopilotModels"
import { refreshGroqModels } from "../models/refreshGroqModels"
import { refreshLiteLlmModels } from "../models/refreshLiteLlmModels"
import { refreshOpenRouterModels } from "../models/refreshOpenRouterModels"
import { sendOpenRouterModelsEvent } from "../models/subscribeToOpenRouterModels"

// Field names for synchronizing a provider's model info into global state
type ProviderModelFields = {
	planId: string
	planInfo: keyof GlobalStateAndSettings
	actId: string
	actInfo: keyof GlobalStateAndSettings
}
const openRouterFields: ProviderModelFields = {
	planId: "planModeOpenRouterModelId",
	planInfo: "planModeOpenRouterModelInfo",
	actId: "actModeOpenRouterModelId",
	actInfo: "actModeOpenRouterModelInfo",
}
const groqFields: ProviderModelFields = {
	planId: "planModeGroqModelId",
	planInfo: "planModeGroqModelInfo",
	actId: "actModeGroqModelId",
	actInfo: "actModeGroqModelInfo",
}
const basetenFields: ProviderModelFields = {
	planId: "planModeBasetenModelId",
	planInfo: "planModeBasetenModelInfo",
	actId: "actModeBasetenModelId",
	actInfo: "actModeBasetenModelInfo",
}
const githubCopilotFields: ProviderModelFields = {
	planId: "planModeGithubCopilotModelId",
	planInfo: "planModeGithubCopilotModelInfo",
	actId: "actModeGithubCopilotModelId",
	actInfo: "actModeGithubCopilotModelInfo",
}

/** Initialize webview when it launches */
export async function initializeWebview(controller: Controller, _request: EmptyRequest): Promise<Empty> {
	try {
		await postCachedOpenRouterModels(controller)
		// Fire-and-forget: refresh each provider's models and sync model info into state
		refreshOpenRouterModels(controller).then((m) => syncProviderModelInfo(controller, m, openRouterFields))
		refreshGroqModels(controller).then((m) => syncProviderModelInfo(controller, m, groqFields))
		refreshBasetenModels(controller).then((m) => syncProviderModelInfo(controller, m, basetenFields))
		refreshGithubCopilotModels().then((m) => syncProviderModelInfo(controller, m, githubCopilotFields))
		await refreshLiteLlmIfConfigured(controller)
		syncTelemetrySetting(controller)
		return Empty.create({})
	} catch (error) {
		Logger.error("Failed to initialize webview:", error)
		return Empty.create({})
	}
}

// Post last cached OpenRouter models for immediate UI availability
async function postCachedOpenRouterModels(controller: Controller): Promise<void> {
	const cached = await controller.readOpenRouterModels()
	if (cached) sendOpenRouterModelsEvent(OpenRouterCompatibleModelInfo.create({ models: cached }))
}

// Refresh LiteLLM models only when both base URL and API key are configured
async function refreshLiteLlmIfConfigured(controller: Controller): Promise<void> {
	const baseUrl = controller.stateManager.getGlobalSettingsKey("liteLlmBaseUrl")
	const apiKey = controller.stateManager.getSecretKey("liteLlmApiKey")
	if (baseUrl && apiKey) await refreshLiteLlmModels()
}
// Update telemetry service based on the user's current telemetry setting
function syncTelemetrySetting(controller: Controller): void {
	controller
		.getStateToPostToWebview()
		.then((state) => telemetryService.updateTelemetryState(state.telemetrySetting !== "disabled"))
}

// Update model info for a provider after refresh, respecting plan/act mode separation
async function syncProviderModelInfo(
	controller: Controller,
	models: Record<string, ModelInfo>,
	f: ProviderModelFields,
): Promise<void> {
	if (!models || Object.keys(models).length === 0) return
	const apiConfig = controller.stateManager.getApiConfiguration() as Record<string, any>
	const separate = controller.stateManager.getGlobalSettingsKey("planActSeparateModelsSetting")
	const mode = controller.stateManager.getGlobalSettingsKey("mode")
	if (separate) return updateCurrentModeModel(controller, models, apiConfig, mode, f)
	const updates: Partial<GlobalStateAndSettings> = {}
	if (apiConfig[f.planId] && models[apiConfig[f.planId]])
		(updates as Record<string, any>)[f.planInfo] = models[apiConfig[f.planId]]
	if (apiConfig[f.actId] && models[apiConfig[f.actId]]) (updates as Record<string, any>)[f.actInfo] = models[apiConfig[f.actId]]
	if (Object.keys(updates).length === 0) return
	controller.stateManager.setGlobalStateBatch(updates)
	await controller.postStateToWebview()
}
// Separate mode: update only the current mode's model info
async function updateCurrentModeModel(
	controller: Controller,
	models: Record<string, ModelInfo>,
	apiConfig: any,
	mode: string,
	f: ProviderModelFields,
): Promise<void> {
	const idField = mode === "plan" ? f.planId : f.actId
	const infoField = mode === "plan" ? f.planInfo : f.actInfo
	const modelId = apiConfig[idField]
	if (!modelId || !models[modelId]) return
	controller.stateManager.setGlobalState(infoField, models[modelId])
	await controller.postStateToWebview()
}
