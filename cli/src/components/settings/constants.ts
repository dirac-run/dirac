import { SETTINGS_DESTINATIONS } from "@shared/settings-presentation"
import { SettingsTab } from "./types"

export interface CliSettingsDestination {
	key: SettingsTab
	label: string
	description: string
	question: string
}

export const CLI_SETTINGS_DESTINATIONS: CliSettingsDestination[] = [
	SettingsTab.MODELS_API,
	SettingsTab.UTILITY_MODEL,
	SettingsTab.APPROVALS,
	SettingsTab.RESPONSES_CONTEXT,
	SettingsTab.RUNNING_TASKS,
	SettingsTab.TOOLS,
	SettingsTab.TERMINAL,
	SettingsTab.GENERAL,
].map((key) => ({
	key,
	label: SETTINGS_DESTINATIONS[key].label,
	description: SETTINGS_DESTINATIONS[key].shortHelp,
	question: SETTINGS_DESTINATIONS[key].question,
}))

// Presentation metadata for boolean settings. The state keys and runtime behavior remain unchanged.
export const FEATURE_SETTINGS = {
	lowVerbosity: {
		stateKey: "lowVerbosityEnabled",
		default: true,
		label: "Low-verbosity responses",
		description: "Keep responses concise while preserving decisions, caveats, and verification.",
	},
	yolo: {
		stateKey: "yoloModeToggled",
		default: false,
		label: "YOLO Mode",
		description: "Run with maximum autonomy and bypass confirmation prompts.",
	},
	subagents: {
		stateKey: "subagentsEnabled",
		default: false,
		label: "Subagents",
		description:
			"Run focused subagents in parallel to research, edit files, run commands, and verify work. This may increase token usage.",
	},
	autoCondense: {
		stateKey: "useAutoCondense",
		default: false,
		label: "Auto-condense conversations",
		description: "Summarize older conversation history as the context window fills.",
	},
	webTools: {
		stateKey: "diracWebToolsEnabled",
		default: true,
		label: "Web search & fetch",
		description:
			"Allow Dirac to search the web and retrieve page content. This is distinct from interactive browser control.",
	},
	strictPlanMode: {
		stateKey: "strictPlanModeEnabled",
		default: true,
		label: "Strict Plan Mode",
		description: "Block file-changing tools in Plan Mode until you explicitly switch to Act.",
	},
	parallelToolCalling: {
		stateKey: "enableParallelToolCalling",
		default: false,
		label: "Parallel tool calling",
		description: "Run independent tool calls concurrently. Execution order is not guaranteed and resource use may increase.",
	},
	doubleCheckCompletion: {
		stateKey: "doubleCheckCompletionEnabled",
		default: false,
		label: "Double-check completion",
		description:
			"Require an additional verification pass before accepting completion. This adds latency and may use more tokens.",
	},
} as const

export type FeatureKey = keyof typeof FEATURE_SETTINGS
