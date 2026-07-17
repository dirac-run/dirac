import type * as acp from "@agentclientprotocol/sdk"
import type { ApiProvider } from "@shared/api"
import type { Settings } from "@shared/storage/state-keys"
import { getProviderModelIdKey } from "@shared/storage/provider-keys"
import { StateManager } from "@/core/storage/StateManager"
import { refreshGithubCopilotModels } from "@/core/controller/models/refreshGithubCopilotModels"
import { filterOpenRouterModelIds } from "@/shared/utils/model-filters"
import type { Mode } from "@/shared/storage/types"
import { getDefaultModelId, getModelList, hasStaticModels } from "../utils/model-metadata.js"
import { fetchOpenRouterModels, usesOpenRouterModels } from "../utils/openrouter-models"
import { getProviderLabel, getValidCliProviders, isValidCliProvider } from "../utils/providers.js"
import type { DiracAcpSession } from "./public-types.js"

/**
 * ACP-level mode IDs surfaced to clients.
 *
 * The two extra modes beyond Dirac's internal {@link Mode} are derived states:
 *   - `auto`  → internal `act` mode with auto-approve on
 *   - `yolo`  → internal `act` mode with auto-approve + yolo on
 *
 * Clients see four modes; internally the mode/auto-approve/yolo toggles are
 * still three separate state keys.
 */
export type AcpModeId = "plan" | "act" | "auto" | "yolo"

const ACP_MODE_OPTIONS: { value: AcpModeId; name: string; description: string }[] = [
	{ value: "plan", name: "Plan", description: "Gather information and create a detailed plan" },
	{ value: "act", name: "Act", description: "Execute actions, asking permission for each tool call" },
	{ value: "auto", name: "Auto-approve", description: "Execute actions, auto-approving all tool calls" },
	{ value: "yolo", name: "YOLO", description: "Execute actions with no safety prompts" },
]

export function acpModeToInternalState(acpMode: AcpModeId): { mode: Mode; autoApprove: boolean; yolo: boolean } {
	switch (acpMode) {
		case "plan":
			return { mode: "plan", autoApprove: false, yolo: false }
		case "act":
			return { mode: "act", autoApprove: false, yolo: false }
		case "auto":
			return { mode: "act", autoApprove: true, yolo: false }
		case "yolo":
			return { mode: "act", autoApprove: true, yolo: true }
	}
}

export function computeAcpModeId(mode: Mode, autoApprove: boolean, yolo: boolean): AcpModeId {
	if (mode === "plan") return "plan"
	if (yolo) return "yolo"
	if (autoApprove) return "auto"
	return "act"
}

const REASONING_EFFORT_OPTIONS: acp.SessionConfigSelectOption[] = [
	{ value: "none", name: "None" },
	{ value: "low", name: "Low" },
	{ value: "medium", name: "Medium" },
	{ value: "high", name: "High" },
	{ value: "xhigh", name: "Extra high" },
]

const THINKING_BUDGET_OPTIONS: acp.SessionConfigSelectOption[] = [
	{ value: "0", name: "Off" },
	{ value: "1024", name: "1,024 tokens" },
	{ value: "4096", name: "4,096 tokens" },
	{ value: "8192", name: "8,192 tokens" },
	{ value: "16384", name: "16,384 tokens" },
	{ value: "32768", name: "32,768 tokens" },
]

export class SessionConfigManager {
	/**
	 * Compute the effective ACP mode ID for a session, considering per-session overrides.
	 *
	 * When `sessionOverrides` is provided, auto-approve and yolo values are read from
	 * the overrides rather than the global StateManager. This prevents concurrent ACP
	 * sessions from interfering with each other's mode state.
	 */
	computeCurrentAcpModeId(mode: Mode, sessionOverrides?: Partial<Settings>): AcpModeId {
		const stateManager = StateManager.get()
		const autoApprove = Boolean(
			sessionOverrides?.autoApproveAllToggled ?? stateManager.getGlobalSettingsKey("autoApproveAllToggled"),
		)
		const yolo = Boolean(sessionOverrides?.yoloModeToggled ?? stateManager.getGlobalSettingsKey("yoloModeToggled"))
		return computeAcpModeId(mode, autoApprove, yolo)
	}

	getSessionModeState(mode: Mode, sessionOverrides?: Partial<Settings>): acp.SessionModeState {
		return {
			availableModes: ACP_MODE_OPTIONS.map(({ value, name, description }) => ({
				id: value,
				name,
				description,
			})),
			currentModeId: this.computeCurrentAcpModeId(mode, sessionOverrides),
		}
	}


	async getSessionConfigOptions(
		session: DiracAcpSession,
		sessionOverrides?: Partial<Settings>,
	): Promise<acp.SessionConfigOption[]> {
		const stateManager = StateManager.get()
		const currentProvider = stateManager.getGlobalSettingsKey(
			session.mode === "act" ? "actModeApiProvider" : "planModeApiProvider",
		) as ApiProvider | undefined
		const currentModelId = await this.getCurrentModeModelId(session.mode, currentProvider)
		const thinkingBudget = String(
			stateManager.getGlobalSettingsKey(
				session.mode === "act" ? "actModeThinkingBudgetTokens" : "planModeThinkingBudgetTokens",
			) ?? 0,
		)
		const reasoningEffort = String(
			stateManager.getGlobalSettingsKey(session.mode === "act" ? "actModeReasoningEffort" : "planModeReasoningEffort") ??
				"medium",
		)

		return [
			{
				id: "mode",
				name: "Mode",
				description: "Session operating mode",
				type: "select",
				category: "mode",
				currentValue: this.computeCurrentAcpModeId(session.mode, sessionOverrides),
				options: ACP_MODE_OPTIONS,
			},
			{
				id: "provider",
				name: "Provider",
				description: "API provider",
				type: "select",
				category: "model",
				currentValue: currentProvider || "",
				options: getValidCliProviders().map((provider) => ({
					value: provider,
					name: getProviderLabel(provider),
				})),
			},
			{
				id: "model",
				name: "Model",
				description: "Model for the current mode",
				type: "select",
				category: "model",
				currentValue: currentModelId || "",
				options: await this.getModelConfigOptions(currentProvider, currentModelId),
			},
			{
				id: "reasoning_effort",
				name: "Reasoning Effort",
				description: "Reasoning effort for models that support it",
				type: "select",
				category: "thought_level",
				currentValue: reasoningEffort,
				options: REASONING_EFFORT_OPTIONS,
			},
			{
				id: "thinking_budget",
				name: "Thinking Budget",
				description: "Extended thinking budget for models that support it",
				type: "select",
				category: "thought_level",
				currentValue: thinkingBudget,
				options: this.withCurrentSelectOption(THINKING_BUDGET_OPTIONS, thinkingBudget, `${thinkingBudget} tokens`),
			},
		]
	}

	async applyProviderConfigOption(session: DiracAcpSession, providerValue: string): Promise<void> {
		if (!isValidCliProvider(providerValue)) {
			throw new Error(`Invalid provider: ${providerValue}`)
		}

		const provider = providerValue as ApiProvider
		const currentModelId = await this.getCurrentModeModelId(session.mode, provider)
		await this.applyProviderAndModel(session, provider, currentModelId)
	}

	async applyModelConfigOption(session: DiracAcpSession, modelValue: string): Promise<void> {
		const stateManager = StateManager.get()
		const provider = stateManager.getGlobalSettingsKey(
			session.mode === "act" ? "actModeApiProvider" : "planModeApiProvider",
		) as ApiProvider | undefined

		if (!provider) {
			throw new Error("Cannot set model before a provider is selected")
		}

		await this.applyProviderAndModel(session, provider, modelValue)
	}

	applyReasoningEffortConfigOption(session: DiracAcpSession, effort: string): void {
		if (!REASONING_EFFORT_OPTIONS.some((option) => option.value === effort)) {
			throw new Error(`Invalid reasoning effort: ${effort}`)
		}

		this.setModeScopedSessionState(session.mode, (mode) => {
			StateManager.get().setGlobalState(
				mode === "act" ? "actModeReasoningEffort" : "planModeReasoningEffort",
				effort as any,
			)
		})
	}

	applyThinkingBudgetConfigOption(session: DiracAcpSession, budgetValue: string): void {
		const budget = Number.parseInt(budgetValue, 10)
		if (Number.isNaN(budget) || budget < 0) {
			throw new Error(`Invalid thinking budget: ${budgetValue}`)
		}

		this.setModeScopedSessionState(session.mode, (mode) => {
			StateManager.get().setGlobalState(
				mode === "act" ? "actModeThinkingBudgetTokens" : "planModeThinkingBudgetTokens",
				budget as any,
			)
		})
	}

	async applyProviderAndModel(session: DiracAcpSession, provider: ApiProvider, modelId: string): Promise<void> {
		this.setModeScopedSessionState(session.mode, (mode) => {
			const providerKey = mode === "act" ? "actModeApiProvider" : "planModeApiProvider"
			StateManager.get().setGlobalState(providerKey, provider)

			const modelKey = getProviderModelIdKey(provider, mode)
			StateManager.get().setGlobalState(modelKey, modelId as any)

			if (mode === "act") {
				session.actModeModelId = `${provider}/${modelId}`
			} else {
				session.planModeModelId = `${provider}/${modelId}`
			}
		})
	}

	async getCurrentModeModelId(mode: Mode, provider?: ApiProvider): Promise<string> {
		if (!provider) return ""
		const modelKey = getProviderModelIdKey(provider, mode)
		return (StateManager.get().getGlobalSettingsKey(modelKey) as string | undefined) || getDefaultModelId(provider)
	}

	private async getModelConfigOptions(
		provider: ApiProvider | undefined,
		currentModelId: string | undefined,
	): Promise<acp.SessionConfigSelectOption[]> {
		const modelIds = await this.getAvailableModelIds(provider, currentModelId)
		return modelIds.map((modelId) => ({ value: modelId, name: modelId }))
	}

	private async getAvailableModelIds(provider: ApiProvider | undefined, currentModelId: string | undefined): Promise<string[]> {
		if (!provider) {
			return []
		}

		let modelIds: string[] = []
		if (usesOpenRouterModels(provider)) {
			modelIds = filterOpenRouterModelIds(await fetchOpenRouterModels(), provider)
		} else if (provider === "github-copilot") {
			modelIds = Object.keys(await refreshGithubCopilotModels()).sort((a, b) => a.localeCompare(b))
		} else if (hasStaticModels(provider)) {
			modelIds = getModelList(provider)
		}

		if (currentModelId && !modelIds.includes(currentModelId)) {
			modelIds = [currentModelId, ...modelIds]
		}

		return modelIds
	}

	private withCurrentSelectOption(
		options: acp.SessionConfigSelectOption[],
		currentValue: string,
		currentName: string,
	): acp.SessionConfigSelectOption[] {
		if (!currentValue || options.some((option) => option.value === currentValue)) {
			return options
		}
		return [{ value: currentValue, name: currentName }, ...options]
	}

	private setModeScopedSessionState(currentMode: Mode, setter: (mode: Mode) => void): void {
		const stateManager = StateManager.get()
		setter(currentMode)

		const separateModels = stateManager.getGlobalSettingsKey("planActSeparateModelsSetting") ?? false
		if (!separateModels) {
			setter(currentMode === "act" ? "plan" : "act")
		}
	}
}
