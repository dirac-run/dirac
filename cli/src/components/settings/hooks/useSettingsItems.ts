import type { AutoApprovalSettings } from "@shared/AutoApprovalSettings"
import type { SandboxSettings } from "@shared/SandboxSettings"
import type { SandboxStatus } from "@shared/proto/dirac/state"
import { createSandboxSettingsItems } from "../sandboxSettingsItems"
import { type ModelProviderSelection } from "@shared/api"
import type { SubagentRole } from "@shared/subagentRoles"
import type { ToolMetadata } from "@shared/ExtensionMessage"
import { SETTINGS_DESTINATIONS, SETTINGS_HELP, TOOL_SOURCE_HELP } from "@shared/settings-presentation"
import { type UtilityModelUseCases } from "@shared/storage"
import type { OpenaiReasoningEffort } from "@shared/storage/types"
import type { TelemetrySetting } from "@shared/TelemetrySetting"
import { useMemo } from "react"
import { version as CLI_VERSION } from "../../../../package.json"
import { getProviderLabel } from "../../../utils/providers"
import { FEATURE_SETTINGS, type FeatureKey } from "../constants"
import { type ListItem, SettingsItemType, SettingsTab } from "../types"

export interface UseSettingsItemsProps {
	sandboxSettings?: SandboxSettings
	sandboxStatus?: SandboxStatus
	sandboxStatusError?: string
	sandboxAdvanced?: boolean
	currentTab: SettingsTab
	provider: string
	planProvider?: string
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
	subagentRoles?: SubagentRole[]
	utilityPermissionPolicy: string
	lightTerminalTheme: boolean
	vimModeEnabled?: boolean
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
	return [
		...(props.unbiasedIsAuthenticated ? [
			{ key: "unbiasedAccount", label: "Unbiased", type: SettingsItemType.READONLY, value: props.unbiasedWorkloadName || "Unbiased" },
			{ key: "unbiasedSignOut", label: "Sign out of Unbiased", type: SettingsItemType.ACTION, value: "" },
		] : [{ key: "unbiasedSignIn", label: "Sign in with Unbiased", type: SettingsItemType.ACTION, value: "" }]),
		...(props.openAiCodexIsAuthenticated ? [{ key: "codexSignOut", label: `ChatGPT · ${props.openAiCodexEmail || "Signed in"}`, type: SettingsItemType.ACTION, value: "Sign out" }] : []),
		...(props.githubIsAuthenticated ? [{ key: "githubSignOut", label: `GitHub · ${props.githubEmail || "Signed in"}`, type: SettingsItemType.ACTION, value: "Sign out" }] : []),
	]
}

function createUtilityItems(props: UseSettingsItemsProps): ListItem[] {
	const { utilityModelUseCases, utilityModelSelection, utilityPermissionPolicy } = props
	const selectionLabel = utilityModelSelection
		? `${getProviderLabel(utilityModelSelection.provider)} · ${utilityModelSelection.modelId}`
		: "Not configured"
	const hasEnabledUseCase = Object.values(utilityModelUseCases).some(Boolean)
	return [
		{ key: "planSelection", label: "Plan", type: SettingsItemType.ACTION, value: props.planModelId || "Required: select a model" },
		{ key: "actSelection", label: "Act", type: SettingsItemType.ACTION, value: props.actModelId || "Required: select a model" },
		checkbox("separateModels", "Use separate Plan / Act configurations", props.separateModels, "When disabled, model selection updates both modes."),
		...(props.provider === "openrouter" ? [editable("actOpenRouterProviders", "Act allowed upstream providers", props.openRouterPinnedProviders[props.actModelId]?.join(", ") || "Unrestricted")] : []),
		...(props.separateModels && props.planProvider === "openrouter" ? [editable("planOpenRouterProviders", "Plan allowed upstream providers", props.openRouterPinnedProviders[props.planModelId]?.join(", ") || "Unrestricted")] : []),
		...(props.provider === "openrouter" || props.planProvider === "openrouter" ? [
			{ key: "openRouterProviderSorting", label: "Provider sorting", type: SettingsItemType.CYCLE, value: props.openRouterProviderSorting || "Default" },
			checkbox("openRouterPreventFallbacks", "Prevent fallbacks", props.openRouterPreventFallbacks, "Fail rather than route to another provider."),
		] : []),
		{
			key: "utilityModelSelection",
			label: "Utility",
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
		{ key: "subagentRolesHeading", label: "Subagent roles", type: SettingsItemType.HEADER, value: "" },
		{ key: "subagentRolesExplanation", label: "", type: SettingsItemType.READONLY, value: "Subagents use the current model by default unless you enable a role with different settings." },
		...(props.subagentRoles ?? []).map((role, index) => ({
			key: `subagentRole:${index}`, label: role.name, type: SettingsItemType.ACTION,
			value: `${role.enabled ? "Enabled" : "Disabled"} · ${role.modelSelection ? `${role.modelSelection.openAiProfileName ?? getProviderLabel(role.modelSelection.provider)} · ${role.modelSelection.modelId}` : "Not configured"}`,
			description: role.description,
		})),
		{ key: "addSubagentRole", label: "Add role", type: SettingsItemType.ACTION, value: "" },
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
		"Read and analyze files under the active workspace without asking. Also permits model-requested conversation condensing; automatic threshold-triggered condensing is controlled separately by Auto-condense conversations.",
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
		checkbox(
			"vimModeEnabled",
			"Vim prompt editing",
			props.vimModeEnabled,
			"Opt into modal prompt editing. Esc enters NORMAL; i returns to INSERT. Applies immediately; starts in INSERT.",
			{ keywords: ["vi", "vim", "bindings", "input", "normal", "insert"] },
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
		case SettingsTab.SANDBOX:
			return createSandboxSettingsItems(props.sandboxSettings, props.sandboxStatus, props.sandboxStatusError, props.sandboxAdvanced)
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
			props.sandboxSettings,
			props.sandboxStatus,
			props.sandboxStatusError,
			props.sandboxAdvanced,
			props.provider,
			props.planProvider,
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
			props.subagentRoles,
			props.utilityPermissionPolicy,
			props.lightTerminalTheme,
			props.vimModeEnabled,
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
