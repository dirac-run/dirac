import type { TaskletRecord } from "@core/task/types/tasklet"
import type { TaskletConfiguration } from "@core/task/TaskletConfiguration"
import { ALL_PROVIDERS, type ModelProviderSelection } from "@shared/api"
import { getProviderModelIdKey, getProviderModelInfoKey } from "@shared/storage/provider-keys"
import { stringifyVsCodeLmModelSelector } from "@shared/vsCodeSelectorUtils"

/** Recover only explicit child-local selections. Never consult today's defaults or role catalog. */
export function historicalTaskletSelection(settings: Record<string, unknown>): ModelProviderSelection | undefined {
	const provider = settings.actModeApiProvider ?? settings.apiProvider
	if (!ALL_PROVIDERS.includes(provider as ModelProviderSelection["provider"])) return undefined
	const selectedProvider = provider as ModelProviderSelection["provider"]
	const selector = settings.actModeVsCodeLmModelSelector as ModelProviderSelection["vsCodeLmModelSelector"]
	const modelId = selectedProvider === "dify" ? "dify-workflow"
		: selectedProvider === "vscode-lm" ? (selector ? stringifyVsCodeLmModelSelector(selector) : undefined)
			: settings[getProviderModelIdKey(selectedProvider, "act")]
	if (typeof modelId !== "string" || !modelId.trim()) return undefined
	const infoKey = getProviderModelInfoKey(selectedProvider, "act")
	return Object.fromEntries(Object.entries({
		provider: selectedProvider,
		modelId,
		modelInfo: infoKey ? settings[infoKey] : undefined,
		openAiProfileName: selectedProvider === "openai" ? settings.actModeOpenAiProfileName : undefined,
		vsCodeLmModelSelector: selectedProvider === "vscode-lm" ? selector : undefined,
		awsBedrockCustomSelected: selectedProvider === "bedrock" ? settings.actModeAwsBedrockCustomSelected : undefined,
		awsBedrockCustomModelBaseId: selectedProvider === "bedrock" ? settings.actModeAwsBedrockCustomModelBaseId : undefined,
		reasoningEffort: settings.actModeReasoningEffort,
		thinkingBudgetTokens: settings.actModeThinkingBudgetTokens,
		geminiThinkingLevel: settings.geminiActModeThinkingLevel,
	}).filter(([, value]) => value !== undefined)) as unknown as ModelProviderSelection
}

/** Read-boundary migration; execution validation stays at resume, not root reconstruction. */
export function migrateTaskletConfiguration(record: TaskletRecord, recovered?: ModelProviderSelection): TaskletRecord {
	const legacy = record.configuration as (TaskletConfiguration & Record<string, unknown>) | undefined
	const role = typeof legacy?.name === "string" && legacy.name.trim() ? legacy.name : record.role
	const selection = legacy?.modelSelection ?? recovered
	const result = { ...record }
	// Retired execution policy is not authority and must never be replayed.
	delete (result as unknown as Record<string, unknown>).purpose
	delete (result as unknown as Record<string, unknown>).inheritedMessageCount
	if (role !== undefined) result.role = role
	if (selection !== undefined) {
		result.configuration = {
			...(role === undefined ? {} : { name: role }), modelSelection: selection,
			// Explicit task-local authority is durable; even malformed snapshots must survive to fail closed at resume.
			...(legacy?.sandboxPolicy === undefined ? {} : { sandboxPolicy: legacy.sandboxPolicy }),
		}
	} else {
		delete result.configuration
	}
	return result
}
