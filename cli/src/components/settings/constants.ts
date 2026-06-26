import { PanelTab } from "../Panel"

export const TABS: PanelTab[] = [
	{ key: "api", label: "API" },
	{ key: "auto-approve", label: "Auto-approve" },
	{ key: "features", label: "Features" },
	{ key: "tools", label: "Tools" },
	{ key: "other", label: "Other" },
]

// Settings configuration for simple boolean toggles
export const FEATURE_SETTINGS = {
	subagents: {
		stateKey: "subagentsEnabled",
		default: false,
		label: "Subagents",
		description: "Let Dirac run focused subagents in parallel to explore the codebase for you",
	},
	autoCondense: {
		stateKey: "useAutoCondense",
		default: false,
		label: "Auto-condense",
		description: "Automatically summarize long conversations",
	},
	webTools: {
		stateKey: "diracWebToolsEnabled",
		default: true,
		label: "Web tools",
		description: "Enable web search and fetch tools",
	},
	strictPlanMode: {
		stateKey: "strictPlanModeEnabled",
		default: true,
		label: "Strict plan mode",
		description: "Require explicit mode switching",
	},
	parallelToolCalling: {
		stateKey: "enableParallelToolCalling",
		default: false,
		label: "Parallel tool calling",
		description: "Allow multiple tools in a single response",
	},
	doubleCheckCompletion: {
		stateKey: "doubleCheckCompletionEnabled",
		default: false,
		label: "Double-check completion",
		description: "Reject first completion attempt and require re-verification",
	},
} as const

export type FeatureKey = keyof typeof FEATURE_SETTINGS
