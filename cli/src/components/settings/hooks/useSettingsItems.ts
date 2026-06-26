import type { ToolMetadata } from "@shared/ExtensionMessage"

import { useMemo } from "react"
import { getProviderLabel } from "../../../utils/providers"
import { StateManager } from "@/core/storage/StateManager"
import { ProviderToBaseUrlKeyMap } from "@shared/storage"
import { ApiProvider } from "@shared/api"
import { supportsReasoningEffortForModel } from "@/utils/model-utils"
import { getModelList, CUSTOM_MODEL_ID } from "../../ModelPicker"
import { usesOpenRouterModels } from "../../../utils/openrouter-models"
import { version as CLI_VERSION } from "../../../../package.json"
import { FEATURE_SETTINGS, type FeatureKey } from "../constants"
import type { ListItem, SettingsTab } from "../types"
import type { AutoApprovalSettings } from "@shared/AutoApprovalSettings"
import type { TelemetrySetting } from "@shared/TelemetrySetting"
import type { OpenaiReasoningEffort } from "@shared/storage/types"

interface UseSettingsItemsProps {
	currentTab: SettingsTab
	provider: string
	actModelId: string
	planModelId: string
	separateModels: boolean
	actThinkingEnabled: boolean
	planThinkingEnabled: boolean
	actReasoningEffort: OpenaiReasoningEffort
	planReasoningEffort: OpenaiReasoningEffort
	autoApproveSettings: AutoApprovalSettings
	features: Record<FeatureKey, boolean>
	preferredLanguage: string
	telemetry: TelemetrySetting
	openAiHeaders: Record<string, string>
	openAiCodexIsAuthenticated: boolean
	openAiCodexEmail?: string
	githubIsAuthenticated: boolean
	githubEmail?: string
	openRouterModels?: string[]
	availableTools: ToolMetadata[]
	toolToggles: Record<string, boolean>
}

export function useSettingsItems({
	currentTab,
	provider,
	actModelId,
	planModelId,
	separateModels,
	actThinkingEnabled,
	planThinkingEnabled,
	actReasoningEffort,
	planReasoningEffort,
	autoApproveSettings,
	openRouterModels,
	features,
	preferredLanguage,
	telemetry,
	openAiHeaders,
	openAiCodexIsAuthenticated,
	openAiCodexEmail,
	githubIsAuthenticated,
	githubEmail,
	availableTools,
	toolToggles,
}: UseSettingsItemsProps): ListItem[] {
	return useMemo(() => {
		const modelList = usesOpenRouterModels(provider) ? openRouterModels || [] : getModelList(provider)
		const isActCustom = actModelId === CUSTOM_MODEL_ID || (actModelId && !modelList.includes(actModelId))
		const isPlanCustom = planModelId === CUSTOM_MODEL_ID || (planModelId && !modelList.includes(planModelId))
		const providerUsesReasoningEffort = provider === "openai-native" || provider === "openai-codex"
		const showActReasoningEffort = supportsReasoningEffortForModel(actModelId || "")
		const showPlanReasoningEffort = supportsReasoningEffortForModel(planModelId || "")
		const showActThinkingOption = !providerUsesReasoningEffort && !showActReasoningEffort
		const showPlanThinkingOption = !providerUsesReasoningEffort && !showPlanReasoningEffort

		switch (currentTab) {
			case "api": {
				const stateManager = StateManager.get()
				return [
					{
						key: "provider" as const,
						label: "Provider",
						type: "editable",
						value: provider ? getProviderLabel(provider) : "not configured",
					},
					...(ProviderToBaseUrlKeyMap[provider as ApiProvider]
						? [
								{
									key: "baseUrl",
									label: "Base URL",
									type: "editable" as const,
									value:
										(stateManager.getGlobalSettingsKey(
											ProviderToBaseUrlKeyMap[provider as ApiProvider]!,
										) as string) || "",
								},
							]
						: []),
					...(provider === "openai"
						? [
								{
									key: "openAiHeaders",
									label: "Custom Headers",
									type: "object" as const,
									value: openAiHeaders,
								},
							]
						: []),
					...(provider === "openai-codex" && openAiCodexIsAuthenticated
						? [
								{
									key: "codexEmail",
									label: "Authenticated as",
									type: "readonly" as const,
									value: openAiCodexEmail || "ChatGPT User",
								},
								{
									key: "codexSignOut",
									label: "Sign Out",
									type: "action" as const,
									value: "",
								},
							]
						: []),
					...(provider === "github-copilot" && githubIsAuthenticated
						? [
								{
									key: "githubEmail",
									label: "Authenticated as",
									type: "readonly" as const,
									value: githubEmail || "GitHub User",
								},
								{
									key: "githubSignOut",
									label: "Sign Out",
									type: "action" as const,
									value: "",
								},
							]
						: []),
					...(provider === "github-copilot" && !githubIsAuthenticated
						? [
								{
									key: "githubSignIn",
									label: "Sign In to GitHub Copilot",
									type: "action" as const,
									value: "",
								},
							]
						: []),
					...(separateModels
						? [
								{ key: "spacer0", label: "", type: "spacer" as const, value: "" },
								{ key: "actHeader", label: "Act Mode", type: "header" as const, value: "" },
								{
									key: "actModelId",
									label: "Model ID",
									type: "editable" as const,
									value: isActCustom ? "Custom" : actModelId || "not set",
								},
								...(isActCustom
									? [
											{
												key: "actCustomModelId",
												label: "Preset/Model",
												type: "editable" as const,
												value: actModelId === CUSTOM_MODEL_ID ? "" : actModelId,
											},
										]
									: []),
								...(showActThinkingOption
									? [
											{
												key: "actThinkingEnabled",
												label: "Enable thinking",
												type: "checkbox" as const,
												value: actThinkingEnabled,
											},
										]
									: []),
								...(showActReasoningEffort
									? [
											{
												key: "actReasoningEffort",
												label: "Reasoning effort",
												type: "cycle" as const,
												value: actReasoningEffort,
											},
										]
									: []),
								{ key: "planHeader", label: "Plan Mode", type: "header" as const, value: "" },
								{
									key: "planModelId",
									label: "Model ID",
									type: "editable" as const,
									value: isPlanCustom ? "Custom" : planModelId || "not set",
								},
								...(isPlanCustom
									? [
											{
												key: "planCustomModelId",
												label: "Preset/Model",
												type: "editable" as const,
												value: planModelId === CUSTOM_MODEL_ID ? "" : planModelId,
											},
										]
									: []),
								...(showPlanThinkingOption
									? [
											{
												key: "planThinkingEnabled",
												label: "Enable thinking",
												type: "checkbox" as const,
												value: planThinkingEnabled,
											},
										]
									: []),
								...(showPlanReasoningEffort
									? [
											{
												key: "planReasoningEffort",
												label: "Reasoning effort",
												type: "cycle" as const,
												value: planReasoningEffort,
											},
										]
									: []),
								{ key: "spacer1", label: "", type: "spacer" as const, value: "" },
							]
						: [
								{
									key: "actModelId",
									label: "Model ID",
									type: "editable" as const,
									value: isActCustom ? "Custom" : actModelId || "not set",
								},
								...(isActCustom
									? [
											{
												key: "actCustomModelId",
												label: "Preset/Model",
												type: "editable" as const,
												value: actModelId === CUSTOM_MODEL_ID ? "" : actModelId,
											},
										]
									: []),
								...(showActThinkingOption
									? [
											{
												key: "actThinkingEnabled",
												label: "Enable thinking",
												type: "checkbox" as const,
												value: actThinkingEnabled,
											},
										]
									: []),
								...(showActReasoningEffort
									? [
											{
												key: "actReasoningEffort",
												label: "Reasoning effort",
												type: "cycle" as const,
												value: actReasoningEffort,
											},
										]
									: []),
							]),
					{
						key: "separateModels",
						label: "Use separate models for Plan and Act",
						type: "checkbox",
						value: separateModels,
					},
				]
			}

			case "auto-approve": {
				const result: ListItem[] = []
				const actions = autoApproveSettings.actions

				const addActionPair = (
					parentKey: string,
					parentLabel: string,
					parentDesc: string,
					childKey: string,
					childLabel: string,
					childDesc: string,
				) => {
					result.push({
						key: parentKey,
						label: parentLabel,
						type: "checkbox",
						value: actions[parentKey as keyof typeof actions] ?? false,
						description: parentDesc,
					})
					if (actions[parentKey as keyof typeof actions]) {
						result.push({
							key: childKey,
							label: childLabel,
							type: "checkbox",
							value: actions[childKey as keyof typeof actions] ?? false,
							description: childDesc,
							isSubItem: true,
							parentKey,
						})
					}
				}

				addActionPair(
					"readFiles",
					"Read and analyze files",
					"Read and analyze files in the working directory",
					"readFilesExternally",
					"Read all files",
					"Read files outside working directory",
				)
				addActionPair(
					"editFiles",
					"Edit and create files",
					"Edit and create files in the working directory",
					"editFilesExternally",
					"Edit all files",
					"Edit files outside working directory",
				)
				result.push({
					key: "executeCommands",
					label: "Auto-approve safe commands",
					type: "checkbox",
					value: actions.executeCommands ?? false,
					description: "Run harmless terminal commands automatically",
				})

				result.push(
					{
						key: "useBrowser",
						label: "Use the browser",
						type: "checkbox",
						value: actions.useBrowser,
						description: "Browse and interact with web pages",
					},
					{ key: "separator", label: "", type: "separator", value: false },
					{
						key: "enableNotifications",
						label: "Enable notifications",
						type: "checkbox",
						value: autoApproveSettings.enableNotifications,
						description: "System alerts when Dirac needs your attention",
					},
				)
				return result
			}

			case "features":
				return Object.entries(FEATURE_SETTINGS).map(([key, config]) => ({
					key,
					label: config.label,
					type: "checkbox" as const,
					value: features[key as FeatureKey],
					description: config.description,
				}))

			case "tools": {
				const SOURCE_ORDER: Array<ToolMetadata["source"]> = ["builtin", "global", "workspace"]
				const SOURCE_LABELS: Record<string, string> = {
					builtin: "Built-in",
					global: "Global",
					workspace: "Workspace",
				}
				const result: ListItem[] = []
				for (const source of SOURCE_ORDER) {
					const tools = availableTools.filter((t) => t.source === source)
					if (tools.length === 0) continue
					result.push({ key: `header-${source}`, label: `${SOURCE_LABELS[source]} Tools`, type: "header", value: "" })
					const sorted = [...tools].sort((a, b) => a.name.localeCompare(b.name))
					for (const tool of sorted) {
						const override = toolToggles[tool.id]
						const isEnabled = override !== undefined ? override : tool.source === "builtin"
						result.push({
							key: tool.id,
							label: tool.name,
							type: "checkbox",
							value: isEnabled,
						})
					}
				}
				return result
			}

			case "other":
				return [
					{ key: "language", label: "Preferred language", type: "editable", value: preferredLanguage },
					{
						key: "telemetry",
						label: "Error/usage reporting",
						type: "checkbox",
						value: telemetry !== "disabled",
						description: "Help improve Dirac by sending anonymous usage data",
					},
					{ key: "separator", label: "", type: "separator", value: "" },
					{ key: "version", label: "", type: "readonly", value: `Dirac v${CLI_VERSION}` },
				]

			default:
				return []
		}
	}, [
		currentTab,
		provider,
		actModelId,
		planModelId,
		separateModels,
		actThinkingEnabled,
		planThinkingEnabled,
		actReasoningEffort,
		planReasoningEffort,
		autoApproveSettings,
		features,
		preferredLanguage,
		telemetry,
		openAiHeaders,
		openAiCodexIsAuthenticated,
		openAiCodexEmail,
		githubIsAuthenticated,
		githubEmail,
		openRouterModels,
		availableTools,
		toolToggles,
	])
}
