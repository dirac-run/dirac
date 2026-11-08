import type { ApiConfiguration, ModelProviderSelection } from "@shared/api"
import { getProviderModelIdKey, getProviderModelInfoKey } from "@shared/storage/provider-keys"
import type { Mode } from "@shared/storage/types"
import { modelProviderSelectionUpdates } from "@shared/modelProviderSelection"
import type { DeepReadonly } from "@/core/task/runtime/TaskWorkingConfiguration"
import { applyApiConfigurationTransaction } from "@/core/controller/models/apiConfigurationTransaction"
import type { Controller } from "@/core/controller"
import { StateManager } from "@/core/storage/StateManager"
import type { Settings } from "@shared/storage/state-keys"

export function readModeSelection(input: DeepReadonly<ApiConfiguration>, mode: Mode): ModelProviderSelection | undefined {
	const config = structuredClone(input) as ApiConfiguration
	const provider = mode === "plan" ? config.planModeApiProvider : config.actModeApiProvider
	if (!provider) return undefined
	const prefix = mode === "plan" ? "planMode" : "actMode"
	const infoKey = getProviderModelInfoKey(provider, mode)
	const profile = provider === "openai" ? config.openAiCompatibleProfiles?.find((item) => item.name === config[`${prefix}OpenAiProfileName`]) : undefined
	const modelId = (config as Record<string, unknown>)[getProviderModelIdKey(provider, mode)] as string || profile?.modelId || ""
	return {
		provider,
		modelId,
		modelInfo: (infoKey ? (config as Record<string, unknown>)[infoKey] as ModelProviderSelection["modelInfo"] : undefined) ?? (modelId === profile?.modelId ? profile?.modelInfo : undefined),
		openAiProfileName: provider === "openai" ? config[`${prefix}OpenAiProfileName`] : undefined,
		vsCodeLmModelSelector: config[`${prefix}VsCodeLmModelSelector`],
		awsBedrockCustomSelected: config[`${prefix}AwsBedrockCustomSelected`],
		awsBedrockCustomModelBaseId: config[`${prefix}AwsBedrockCustomModelBaseId`],
		reasoningEffort: config[`${prefix}ReasoningEffort`] as ModelProviderSelection["reasoningEffort"],
		thinkingBudgetTokens: config[`${prefix}ThinkingBudgetTokens`],
		geminiThinkingLevel: mode === "plan" ? config.geminiPlanModeThinkingLevel : config.geminiActModeThinkingLevel,
	}
}

/** The input is shared; these explicit bindings keep independent saves out of Plan/Act. */
export async function saveApplicationModelSelection(target: Mode | "utility", selection: ModelProviderSelection, separate: boolean, controller?: Controller): Promise<void> {
	if (!selection.modelId.trim() || selection.modelId === "__custom__") throw new Error("Enter a model ID")
	const state = StateManager.get()
	const patch = target === "utility" ? { utilityModelSelection: selection } : Object.assign({},
		... (separate ? [target] : ["plan", "act"] as Mode[]).map((mode) => modelProviderSelectionUpdates(mode, selection,
			(controller?.task?.getWorkingConfiguration().apiConfiguration ?? state.getApiConfiguration())[mode === "plan" ? "planModeInferenceSpeed" : "actModeInferenceSpeed"])),
	)
	const previous = Object.fromEntries(Object.keys(patch).map((key) => [key, structuredClone(state.getSystemDefaultSettingsKey(key as keyof Settings))]))
	const persist = async () => {
		try { state.setGlobalStateBatch(patch); await state.flushPendingState() }
		catch (error) { state.setGlobalStateBatch(previous); await state.flushPendingState(); throw error }
	}
	if (target === "utility") {
		if (controller?.task) await controller.task.applyWorkingConfigurationUpdate({ settings: patch }, persist)
		else await persist()
	} else {
		await applyApiConfigurationTransaction(controller ?? { stateManager: state }, { ...state.getApiConfiguration(), ...patch }, persist, undefined, patch)
	}
	await controller?.postStateToWebview()
}
