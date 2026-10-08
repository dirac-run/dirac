import type { AutoApprovalSettings } from "@shared/AutoApprovalSettings"
import { type ApiProvider, getModelInfoForProvider, type ModelProviderSelection } from "@shared/api"
import type { ToolMetadata } from "@shared/ExtensionMessage"
import { SETTINGS_DESTINATIONS, SETTINGS_HELP, TOOL_SOURCE_HELP } from "@shared/settings-presentation"
import { ProviderToBaseUrlKeyMap, type UtilityModelUseCases } from "@shared/storage"
import type { OpenaiReasoningEffort } from "@shared/storage/types"
import type { TelemetrySetting } from "@shared/TelemetrySetting"
import { getReasoningEffortOptionsForModel, resolveReasoningEffortForModel } from "@shared/utils/reasoning-support"
import { useMemo } from "react"
import { StateManager } from "@/core/storage/StateManager"
import { version as CLI_VERSION } from "../../../../package.json"
import { usesOpenRouterModels } from "../../../utils/openrouter-models"
import { getProviderLabel } from "../../../utils/providers"
import { CUSTOM_MODEL_ID, getModelList } from "../../ModelPicker"
import { FEATURE_SETTINGS, type FeatureKey } from "../constants"
import { type ListItem, SettingsItemType, SettingsTab } from "../types"

export interface UseSettingsItemsProps {
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
	autoApproveAllToggled: boolean
	features: Record<FeatureKey, boolean>
	utilityModelUseCases: UtilityModelUseCases
	utilityModelSelection?: ModelProviderSelection
	utilityPermissionPolicy: string
	lightTerminalTheme: boolean
	preferredLanguage: string
	telemetry: TelemetrySetting
	openAiHeaders: Record<string, string>
	autoCondenseContextLimit: number
	openAiCodexIsAuthenticated: boolean
	unbiasedIsAuthenticated: boolean
	unbiasedWorkloadName?: string
	openAiCodexEmail?: string
	githubIsAuthenticated: boolean
	githubEmail?: string
	openRouterModels?: string[]
	openRouterPinnedProviders: Record<string, string[]>
	openRouterProviderSorting?: string
	openRouterPreventFallbacks: boolean
	availableTools: ToolMetadata[]
	toolToggles: Record<string, boolean>
}

const editable = (key: string, label: string, value: unknown, description?: string): ListItem => ({
	key,
	label,
	type: SettingsItemType.EDITABLE,
	value,
	description,
})

const checkbox = (
	key: string,
	label: string,
	value: boolean | undefined,
	description: string,
	extra: Partial<ListItem> = {},
): ListItem => ({
	key,
	label,
	type: SettingsItemType.CHECKBOX,
	value: value ?? false,
	description,
	...extra,
})

function createModelItems(props: UseSettingsItemsProps): ListItem[] {
	const {
		provider,
		actModelId,
		planModelId,
		separateModels,
		actThinkingEnabled,
		planThinkingEnabled,
		actReasoningEffort,
		planReasoningEffort,
		openAiHeaders,
		openAiCodexIsAuthenticated,
		unbiasedIsAuthenticated,
		unbiasedWorkloadName,
		openAiCodexEmail,
		githubIsAuthenticated,
		githubEmail,
		openRouterModels,
		openRouterPinnedProviders,
		openRouterProviderSorting,
		openRouterPreventFallbacks,
	} = props
	const stateManager = StateManager.get()
	const modelList = usesOpenRouterModels(provider) ? openRouterModels || [] : getModelList(provider)
	const isActCustom = actModelId === CUSTOM_MODEL_ID || Boolean(actModelId && !modelList.includes(actModelId))
	const isPlanCustom = planModelId === CUSTOM_MODEL_ID || Boolean(planModelId && !modelList.includes(planModelId))
	const providerId = provider as ApiProvider
	const actModelInfo = getModelInfoForProvider(providerId, actModelId)
	const planModelInfo = getModelInfoForProvider(providerId, planModelId)
	const actReasoningEffortOptions = getReasoningEffortOptionsForModel(actModelId, actModelInfo)
	const planReasoningEffortOptions = getReasoningEffortOptionsForModel(planModelId, planModelInfo)
	const showActReasoningEffort = actReasoningEffortOptions.length > 0
	const showPlanReasoningEffort = planReasoningEffortOptions.length > 0
	const providerHidesThinkingBudget = provider === "openai-native" || provider === "openai-codex" || provider === "unbiased" || provider === "zai"
	const showActThinkingOption = !providerHidesThinkingBudget && !showActReasoningEffort
	const showPlanThinkingOption = !providerHidesThinkingBudget && !showPlanReasoningEffort
	const displayedActReasoningEffort =
		resolveReasoningEffortForModel(actModelId, actModelInfo, actReasoningEffort) ?? actReasoningEffort
	const displayedPlanReasoningEffort =
		resolveReasoningEffortForModel(planModelId, planModelInfo, planReasoningEffort) ?? planReasoningEffort
	const isOpenRouter = provider === "openrouter"
	const formatPinnedProviderCount = (modelId: string) => {
		const count = openRouterPinnedProviders[modelId]?.length || 0
		return count > 0 ? `${count} allowed` : "Unrestricted"
	}
	const providerSortingLabel = openRouterProviderSorting
		? openRouterProviderSorting[0].toUpperCase() + openRouterProviderSorting.slice(1)
		: "Default"
	const modelItems = (
		mode: "act" | "plan",
		modelId: string,
		isCustom: boolean,
		thinkingEnabled: boolean,
		reasoningEffort: OpenaiReasoningEffort,
		reasoningEffortOptions: readonly OpenaiReasoningEffort[],
		showThinking: boolean,
		showReasoning: boolean,
	): ListItem[] => {
		const prefix = mode === "act" ? "act" : "plan"
		return [
			editable(
				`${prefix}ModelId`,
				"Task model",
				isCustom ? "Custom" : modelId || "not set",
				"The model used for the current task mode.",
			),
			...(isCustom
				? [editable(`${prefix}CustomModelId`, "Preset / model ID", modelId === CUSTOM_MODEL_ID ? "" : modelId)]
				: []),
			...(isOpenRouter
				? [
					editable(
						`${prefix}OpenRouterProviders`,
						mode === "plan" && planModelId === actModelId
							? "Allowed upstream providers (shared with Act)"
							: "Allowed upstream providers",
						formatPinnedProviderCount(modelId),
						"Restrict which upstream providers OpenRouter may use. Restrictions can reduce availability.",
					),
				]
				: []),
			...(showThinking
				? [
					checkbox(
						`${prefix}ThinkingEnabled`,
						"Thinking budget (1,024 tokens)",
						thinkingEnabled,
						"Enable the existing 1,024-token extended-thinking budget. Thinking may increase latency and cost.",
					),
				]
				: []),
			...(showReasoning
				? [
					{
						key: `${prefix}ReasoningEffort`,
						label: "Reasoning effort",
						type: SettingsItemType.CYCLE,
						value: reasoningEffort,
						cycleOptions: reasoningEffortOptions,
						description: "Higher effort can improve depth but usually increases latency and token usage.",
					},
				]
				: []),
		]
	}

	return [
		editable(
			"provider",
			"Provider",
			provider ? getProviderLabel(provider) : "not configured",
			"The API provider used by the main task model.",
		),
		...(ProviderToBaseUrlKeyMap[provider as ApiProvider]
			? [
				editable(
					"baseUrl",
					"Base URL",
					(stateManager.getGlobalSettingsKey(ProviderToBaseUrlKeyMap[provider as ApiProvider]!) as string) || "",
					"Base address of an OpenAI-compatible API. Do not include /chat/completions.",
				),
			]
			: []),
		...(provider === "openai"
			? [
				{
					key: "openAiHeaders",
					label: "Custom headers",
					type: SettingsItemType.OBJECT,
					value: openAiHeaders,
					description: "Additional sensitive headers sent with requests to this provider.",
				},
			]
			: []),
		...(provider === "unbiased"
			? unbiasedIsAuthenticated
				? [
					{
						key: "unbiasedAccount",
						label: "Signed in to",
						type: SettingsItemType.READONLY,
						value: unbiasedWorkloadName || "Unbiased",
					},
					{ key: "unbiasedSignOut", label: "Sign out on this device", type: SettingsItemType.ACTION, value: "" },
				]
				: [{ key: "unbiasedSignIn", label: "Sign in with Unbiased", type: SettingsItemType.ACTION, value: "" }]
			: []),
		...(provider === "openai-codex" && openAiCodexIsAuthenticated
			? [
				{
					key: "codexEmail",
					label: "Authenticated as",
					type: SettingsItemType.READONLY,
					value: openAiCodexEmail || "ChatGPT User",
				},
				{
					key: "codexSignOut",
					label: "Sign out",
					type: SettingsItemType.ACTION,
					value: "",
				},
			]
			: []),
		...(provider === "github-copilot" && githubIsAuthenticated
			? [
				{
					key: "githubEmail",
					label: "Authenticated as",
					type: SettingsItemType.READONLY,
					value: githubEmail || "GitHub User",
				},
				{
					key: "githubSignOut",
					label: "Sign out",
					type: SettingsItemType.ACTION,
					value: "",
				},
			]
			: []),
		...(provider === "github-copilot" && !githubIsAuthenticated
			? [
				{
					key: "githubSignIn",
					label: "Sign in to GitHub Copilot",
					type: SettingsItemType.ACTION,
					value: "",
				},
			]
			: []),
		...(separateModels
			? [
				{
					key: "actHeader",
					label: "Act Mode",
					type: SettingsItemType.HEADER,
					value: "",
				},
				...modelItems(
					"act",
					actModelId,
					isActCustom,
					actThinkingEnabled,
					displayedActReasoningEffort,
					actReasoningEffortOptions,
					showActThinkingOption,
					showActReasoningEffort,
				),
				{
					key: "planHeader",
					label: "Plan Mode",
					type: SettingsItemType.HEADER,
					value: "",
				},
				...modelItems(
					"plan",
					planModelId,
					isPlanCustom,
					planThinkingEnabled,
					displayedPlanReasoningEffort,
					planReasoningEffortOptions,
					showPlanThinkingOption,
					showPlanReasoningEffort,
				),
			]
			: modelItems(
				"act",
				actModelId,
				isActCustom,
				actThinkingEnabled,
				displayedActReasoningEffort,
				actReasoningEffortOptions,
				showActThinkingOption,
				showActReasoningEffort,
			)),
		...(isOpenRouter
			? [
				{
					key: "openRouterProviderSorting",
					label: "Provider sorting",
					type: SettingsItemType.CYCLE,
					value: providerSortingLabel,
					description: "Choose how OpenRouter prioritizes eligible upstream providers.",
				},
				checkbox(
					"openRouterPreventFallbacks",
					"Prevent fallbacks",
					openRouterPreventFallbacks,
					"Fail instead of routing to another eligible provider. This can reduce reliability.",
				),
			]
			: []),
		checkbox(
			"separateModels",
			"Use separate models for Plan and Act",
			separateModels,
			"Use one provider/model for planning and another for implementation. Before disabling, review which Act settings become shared.",
		),
	]
}

function createUtilityItems(props: UseSettingsItemsProps): ListItem[] {
	const { utilityModelUseCases, utilityModelSelection, utilityPermissionPolicy } = props
	const selectionLabel = utilityModelSelection
		? `${getProviderLabel(utilityModelSelection.provider)} · ${utilityModelSelection.modelId}`
		: "Not configured"
	const hasEnabledUseCase = Object.values(utilityModelUseCases).some(Boolean)
	return [
		{
			key: "utilityIntroduction",
			label: "",
			type: SettingsItemType.READONLY,
			value: "Uses credentials already configured for the selected provider; credentials are not copied into this selection.",
		},
		{
			key: "utilityModelSelection",
			label: "Provider & model",
			type: SettingsItemType.ACTION,
			value: selectionLabel,
			description: "The model used for the enabled supporting operations below.",
		},
		checkbox(
			"utilityModelUseCondense",
			"Condense conversations",
			utilityModelUseCases.condense,
			"Summarize long conversations before their context limit is reached.",
		),
		checkbox(
			"utilityModelUseNewTask",
			"New-task handoffs",
			utilityModelUseCases.newTask,
			"Generate a complete handoff from a concise new-task intent.",
		),
		checkbox(
			"utilityModelUseGenerateCommitMessage",
			"Generate commit messages",
			utilityModelUseCases.generateCommitMessage,
			"Generate Git commit messages in supported hosts.",
		),
		checkbox(
			"utilityModelUsePermissionHandling",
			"Handle permission requests",
			utilityModelUseCases.permissionHandling,
			"Apply your policy to approve a tool request or escalate it to you.",
		),
		editable(
			"utilityModelPermissionPolicy",
			"Approval policy",
			utilityPermissionPolicy,
			SETTINGS_HELP.utilityPermissionFallback,
		),
		...(hasEnabledUseCase && !utilityModelSelection
			? [
				{
					key: "utilityModelConfigurationWarning",
					label: "",
					type: SettingsItemType.READONLY,
					value: "Select a Utility Model provider and model before this use case can run.",
				},
			]
			: []),
		...(utilityModelUseCases.permissionHandling && !utilityPermissionPolicy.trim()
			? [
				{
					key: "utilityPolicyWarning",
					label: "",
					type: SettingsItemType.READONLY,
					value: "Add an approval policy before AI-assisted permission handling can run.",
				},
			]
			: []),
		{
			key: "utilityModelDisclosure",
			label: "",
			type: SettingsItemType.READONLY,
			value: SETTINGS_HELP.utilityDisclosure,
		},
	]
}

function createApprovalItems(props: UseSettingsItemsProps): ListItem[] {
	const {
		autoApproveSettings,
		autoApproveAllToggled,
		features,
		utilityModelUseCases,
		utilityModelSelection,
		utilityPermissionPolicy,
	} = props
	const actions = autoApproveSettings.actions
	const result: ListItem[] = [
		{
			key: "approvalIntroduction",
			label: "",
			type: SettingsItemType.READONLY,
			value: "Control which actions Dirac may take without requesting confirmation.",
		},
	]
	const addPair = (
		parentKey: keyof typeof actions,
		parentLabel: string,
		parentDescription: string,
		childKey: keyof typeof actions,
		childLabel: string,
		childDescription: string,
	) => {
		result.push(checkbox(parentKey, parentLabel, actions[parentKey], parentDescription))
		if (actions[parentKey]) {
			result.push(
				checkbox(childKey, childLabel, actions[childKey], childDescription, {
					isSubItem: true,
					parentKey,
				}),
			)
		}
	}
	addPair(
		"readFiles",
		"Read files in the workspace",
		"Read and analyze files under the active workspace without asking.",
		"readFilesExternally",
		"Read files outside the workspace",
		"Also read files outside the active workspace without asking.",
	)
	addPair(
		"editFiles",
		"Edit files in the workspace",
		"Edit and create files under the active workspace without asking.",
		"editFilesExternally",
		"Edit files outside the workspace",
		"Also edit and create files outside the active workspace without asking. Use with care.",
	)
	result.push(
		checkbox(
			"executeCommands",
			"Auto-approve safe commands",
			actions.executeCommands,
			"Run terminal commands that Dirac's existing safety checks classify as safe.",
		),
		checkbox("applyDiff", "Apply anchored edits", actions.applyDiff, "Apply line-anchored workspace edits without asking."),
		checkbox(
			"useBrowser",
			"Auto-approve browser actions",
			actions.useBrowser,
			"Launch and interact with web pages without asking.",
		),
		{
			key: "approvedCommandRules",
			label: "Approved command rules",
			type: SettingsItemType.ACTION,
			value: "Manage",
			description:
				"Matching commands bypass confirmation and built-in command safety validation; configured permission rules still apply.",
		},
		checkbox(
			"strictPlanMode",
			FEATURE_SETTINGS.strictPlanMode.label,
			features.strictPlanMode,
			FEATURE_SETTINGS.strictPlanMode.description,
		),
		{
			key: "utilityApprovalsStatus",
			label: "AI-assisted approvals",
			type: SettingsItemType.ACTION,
			value:
				utilityModelUseCases.permissionHandling && utilityModelSelection && utilityPermissionPolicy.trim()
					? "Enabled with Utility Model"
					: "Not configured",
			description:
				"Shows whether Utility Model permission handling is configured. Enter to configure its model and policy.",
		},
		checkbox(
			"enableNotifications",
			"Enable notifications",
			autoApproveSettings.enableNotifications,
			"Send a system notification when Dirac needs your attention.",
		),
		checkbox(
			"autoApproveAll",
			"Approve All",
			autoApproveAllToggled,
			"Approve every tool action, including unsafe terminal commands.",
			{
				persistentHelp: SETTINGS_HELP.approveAll,
				helpTone: "warning",
			},
		),
		checkbox("yolo", FEATURE_SETTINGS.yolo.label, features.yolo, FEATURE_SETTINGS.yolo.description, {
			persistentHelp: `${SETTINGS_HELP.yolo} ${SETTINGS_HELP.yoloPrecedence}`,
			alwaysShowHelp: true,
			helpTone: "error",
		}),
	)
	return result
}

function createResponsesItems(props: UseSettingsItemsProps): ListItem[] {
	const { preferredLanguage, features, autoCondenseContextLimit } = props
	return [
		editable("language", "Preferred language", preferredLanguage, "The language Dirac uses to communicate with you."),
		checkbox(
			"lowVerbosity",
			FEATURE_SETTINGS.lowVerbosity.label,
			features.lowVerbosity,
			FEATURE_SETTINGS.lowVerbosity.description,
		),
		checkbox(
			"autoCondense",
			FEATURE_SETTINGS.autoCondense.label,
			features.autoCondense,
			FEATURE_SETTINGS.autoCondense.description,
		),
		editable(
			"autoCondenseContextLimit",
			"Condense threshold",
			String(autoCondenseContextLimit),
			"Condense at this provider-specific token count. Models with smaller context windows may condense sooner.",
		),
	]
}

function createRunningTaskItems(props: UseSettingsItemsProps): ListItem[] {
	const { features } = props
	return [
		checkbox("subagents", FEATURE_SETTINGS.subagents.label, features.subagents, FEATURE_SETTINGS.subagents.description),
		checkbox(
			"parallelToolCalling",
			FEATURE_SETTINGS.parallelToolCalling.label,
			features.parallelToolCalling,
			FEATURE_SETTINGS.parallelToolCalling.description,
		),
		checkbox(
			"doubleCheckCompletion",
			FEATURE_SETTINGS.doubleCheckCompletion.label,
			features.doubleCheckCompletion,
			FEATURE_SETTINGS.doubleCheckCompletion.description,
		),
	]
}

export function createToolItems(props: UseSettingsItemsProps): ListItem[] {
	const { features, availableTools, toolToggles } = props
	const result: ListItem[] = [
		checkbox("webTools", FEATURE_SETTINGS.webTools.label, features.webTools, FEATURE_SETTINGS.webTools.description),
	]
	const sourceOrder: Array<ToolMetadata["source"]> = ["builtin", "global", "workspace", "task"]
	const sourceLabels: Record<ToolMetadata["source"], string> = {
		builtin: "Built-in",
		global: "Global",
		workspace: "Workspace",
		task: "Task",
	}
	for (const source of sourceOrder) {
		const tools = availableTools.filter((tool) => tool.source === source).sort((a, b) => a.name.localeCompare(b.name))
		if (tools.length === 0) continue
		result.push({
			key: `header-${source}`,
			label: `${sourceLabels[source]} tools`,
			type: SettingsItemType.HEADER,
			value: "",
		})
		for (const tool of tools) {
			const keywords = [sourceLabels[source], tool.id]
			if (source === "task") {
				result.push({
					key: tool.id,
					label: tool.name,
					type: SettingsItemType.READONLY,
					value: "Enabled",
					description: `${tool.description} Task-scoped tools are always enabled.`,
					expandedHelp: TOOL_SOURCE_HELP.task,
					keywords,
				})
				continue
			}
			const override = toolToggles[tool.id]
			result.push(
				checkbox(
					tool.id,
					tool.name,
					override !== undefined ? override : source === "builtin",
					`${tool.description} Changes are saved to global settings.`,
					{ expandedHelp: TOOL_SOURCE_HELP[source], keywords },
				),
			)
		}
	}
	return result
}

function createTerminalItems(props: UseSettingsItemsProps): ListItem[] {
	return [
		checkbox(
			"lightTerminalTheme",
			"Light terminal color theme",
			props.lightTerminalTheme,
			"Choose the CLI palette. DIRAC_COLOR_MODE overrides this preference. A restart is currently required.",
		),
	]
}

function createGeneralItems(props: UseSettingsItemsProps): ListItem[] {
	return [
		checkbox(
			"telemetry",
			"Error & usage reporting",
			props.telemetry !== "disabled",
			"Help improve Dirac by sending usage data and error reports. No code, prompts, or personal information are sent.",
		),
		{
			key: "documentation",
			label: "Documentation",
			type: SettingsItemType.ACTION,
			value: "https://dirac.run/docs/",
			description: "Open the Dirac documentation.",
		},
		{
			key: "communitySupport",
			label: "Community & support",
			type: SettingsItemType.ACTION,
			value: "https://discord.gg/wcYTx9BGea",
			description: "Open the Dirac community support channel.",
		},
		{
			key: "version",
			label: "Version",
			type: SettingsItemType.READONLY,
			value: `Dirac v${CLI_VERSION}`,
		},
		{
			key: "advancedConfiguration",
			label: "Advanced configuration",
			type: SettingsItemType.ACTION,
			value: "dirac config",
			description: "Edit advanced configuration, rules, workflows, hooks, and skills in the separate dirac config surface.",
			expandedHelp:
				"Close Settings and run `dirac config`. It remains separate because it includes raw global/workspace state and customization files.",
			keywords: ["raw settings", "global", "workspace", "rules", "workflows", "hooks", "skills"],
		},
	]
}

export function createSettingsItems(props: UseSettingsItemsProps): ListItem[] {
	switch (props.currentTab) {
		case SettingsTab.MODELS_API:
			return createModelItems(props)
		case SettingsTab.UTILITY_MODEL:
			return createUtilityItems(props)
		case SettingsTab.APPROVALS:
			return createApprovalItems(props)
		case SettingsTab.RESPONSES_CONTEXT:
			return createResponsesItems(props)
		case SettingsTab.RUNNING_TASKS:
			return createRunningTaskItems(props)
		case SettingsTab.TOOLS:
			return createToolItems(props)
		case SettingsTab.TERMINAL:
			return createTerminalItems(props)
		case SettingsTab.GENERAL:
			return createGeneralItems(props)
		default:
			return []
	}
}

export function useSettingsItems(props: UseSettingsItemsProps): ListItem[] {
	return useMemo(
		() => createSettingsItems(props),
		[
			props.currentTab,
			props.provider,
			props.actModelId,
			props.planModelId,
			props.separateModels,
			props.actThinkingEnabled,
			props.planThinkingEnabled,
			props.actReasoningEffort,
			props.planReasoningEffort,
			props.autoApproveSettings,
			props.autoApproveAllToggled,
			props.features,
			props.utilityModelUseCases,
			props.utilityModelSelection,
			props.utilityPermissionPolicy,
			props.lightTerminalTheme,
			props.preferredLanguage,
			props.telemetry,
			props.openAiHeaders,
			props.autoCondenseContextLimit,
			props.openAiCodexIsAuthenticated,
			props.unbiasedIsAuthenticated,
			props.unbiasedWorkloadName,
			props.openAiCodexEmail,
			props.githubIsAuthenticated,
			props.githubEmail,
			props.openRouterModels,
			props.openRouterPinnedProviders,
			props.openRouterProviderSorting,
			props.openRouterPreventFallbacks,
			props.availableTools,
			props.toolToggles,
		],
	)
}

const SETTINGS_SEARCH_ALIASES: Record<string, string[]> = {
	provider: ["API configuration", "api-config"],
	utilityModelSelection: ["Utility Model configuration", "utility-model"],
	approvedCommandRules: ["User-approved commands", "user-approved-commands", "approved commands"],
	strictPlanMode: ["strict-plan-mode"],
	autoApproveAll: ["auto approve all"],
	yolo: ["Yolo Mode"],
	lowVerbosity: ["low-verbosity responses", "low-verbosity-responses"],
	autoCondense: ["Auto Compact", "auto-compact", "auto-condense-conversations"],
	parallelToolCalling: ["parallel-tool-calling"],
	doubleCheckCompletion: ["double-check-completion"],
	webTools: ["Dirac web tools", "dirac-web-tools"],
	lightTerminalTheme: ["terminal theme"],
}

const DESTINATION_SEARCH_ALIASES: Partial<Record<SettingsTab, string[]>> = {
	[SettingsTab.MODELS_API]: ["API", "api-config"],
	[SettingsTab.UTILITY_MODEL]: ["utility-model"],
	[SettingsTab.APPROVALS]: ["Auto-approve", "Approved commands", "user-approved-commands"],
	[SettingsTab.RESPONSES_CONTEXT]: ["responses-context"],
	[SettingsTab.RUNNING_TASKS]: ["Features", "running-tasks"],
	[SettingsTab.GENERAL]: ["Other"],
}

export function createSettingsSearchResults(
	props: UseSettingsItemsProps,
	destinations: SettingsTab[],
): import("../types").SettingsSearchResult[] {
	return destinations.flatMap((destination) => {
		const destinationPresentation = SETTINGS_DESTINATIONS[destination]
		return createSettingsItems({ ...props, currentTab: destination })
			.map((item, itemIndex) => ({ item, itemIndex }))
			.filter(
				({ item }) => ![SettingsItemType.HEADER, SettingsItemType.SEPARATOR, SettingsItemType.SPACER].includes(item.type),
			)
			.map(({ item, itemIndex }) => ({
				id: `${destination}:${item.key}`,
				destination,
				destinationLabel: destinationPresentation.label,
				itemIndex,
				item,
				searchText: [
					item.key,
					...(SETTINGS_SEARCH_ALIASES[item.key] ?? []),
					...(DESTINATION_SEARCH_ALIASES[destination] ?? []),
					destinationPresentation.id,
					item.label,
					String(item.value ?? ""),
					item.description,
					item.expandedHelp,
					item.persistentHelp,
					...(item.keywords ?? []),
					destinationPresentation.label,
					destinationPresentation.shortHelp,
					...destinationPresentation.keywords,
				]
					.filter(Boolean)
					.join(" ")
					.toLowerCase(),
			}))
	})
}
