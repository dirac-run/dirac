export const SETTINGS_DESTINATION_IDS = [
	"models-api",
	"utility-model",
	"approvals",
	"responses-context",
	"running-tasks",
	"tools",
	"terminal",
	"browser",
	"general",
] as const

export type SettingsDestinationId = (typeof SETTINGS_DESTINATION_IDS)[number]

export interface SettingsDestinationPresentation {
	id: SettingsDestinationId
	label: string
	compactLabel: string
	question: string
	shortHelp: string
	webviewTooltip: string
	keywords: string[]
}

export const SETTINGS_DESTINATIONS: Record<SettingsDestinationId, SettingsDestinationPresentation> = {
	"models-api": {
		id: "models-api",
		label: "API providers",
		compactLabel: "Providers",
		question: "Which providers can Dirac access?",
		shortHelp: "Add providers and configure authentication or endpoints",
		webviewTooltip: "Save provider access without changing your model selection.",
		keywords: ["api", "provider", "credentials", "authentication", "endpoint"],
	},
	"utility-model": {
		id: "utility-model",
		label: "Model configurations",
		compactLabel: "Models",
		question: "Which models should Dirac use?",
		shortHelp: "Configure Plan, Act, Utility, and subagent models",
		webviewTooltip: "Choose models and supported reasoning settings for each use.",
		keywords: ["model", "plan", "act", "utility", "reasoning", "thinking", "subagent", "role", "condense", "commit", "permission"],
	},
	approvals: {
		id: "approvals",
		label: "Approvals",
		compactLabel: "Approvals",
		question: "What can Dirac do without asking me?",
		shortHelp: "Control what can run without asking",
		webviewTooltip: "Control which actions can run without asking you.",
		keywords: ["auto approve", "approve all", "yolo", "permission", "commands", "strict plan"],
	},
	"responses-context": {
		id: "responses-context",
		label: "Responses & Context",
		compactLabel: "Responses",
		question: "How should Dirac communicate and handle long chats?",
		shortHelp: "Change language, verbosity, or long-chat handling",
		webviewTooltip: "Control response style and long-conversation handling.",
		keywords: ["language", "verbosity", "concise", "condense", "compact", "context"],
	},
	"running-tasks": {
		id: "running-tasks",
		label: "Running Tasks",
		compactLabel: "Tasks",
		question: "How should Dirac carry out and verify work?",
		shortHelp: "Configure parallel work and verification",
		webviewTooltip: "Configure how Dirac carries out and verifies work.",
		keywords: ["subagent", "parallel", "verification", "checkpoints", "worktrees", "background edits"],
	},
	tools: {
		id: "tools",
		label: "Tools",
		compactLabel: "Tools",
		question: "Which capabilities can Dirac use?",
		shortHelp: "Enable built-in and custom capabilities",
		webviewTooltip: "Enable or disable built-in and custom capabilities.",
		keywords: ["web search", "fetch", "hooks", "builtin", "global", "workspace", "task"],
	},
	terminal: {
		id: "terminal",
		label: "Terminal",
		compactLabel: "Terminal",
		question: "How does Dirac run commands?",
		shortHelp: "Configure command execution and appearance",
		webviewTooltip: "Configure how Dirac runs and captures commands.",
		keywords: ["shell", "command", "profile", "execution", "reuse", "output", "theme"],
	},
	browser: {
		id: "browser",
		label: "Browser",
		compactLabel: "Browser",
		question: "How does Dirac browse and interact with pages?",
		shortHelp: "Configure browsing when supported by this host",
		webviewTooltip: "Configure local or remote browser interaction.",
		keywords: ["chrome", "viewport", "remote debugging", "browser arguments"],
	},
	general: {
		id: "general",
		label: "General",
		compactLabel: "General",
		question: "General preferences, privacy, support, and diagnostics",
		shortHelp: "Privacy, diagnostics, help, and version",
		webviewTooltip: "Privacy, diagnostics, help, support, and version information.",
		keywords: ["privacy", "telemetry", "artifacts", "documentation", "support", "version", "advanced", "debug"],
	},
}

export const TOOL_SOURCE_HELP = {
	builtin: "Included with Dirac.",
	global: "Discovered from your global Dirac configuration.",
	workspace: "Discovered from the active workspace.",
	task: "Available only for the current task.",
} as const

export const SETTINGS_HELP = {
	approveAll:
		"Approve All automatically approves every tool action, including all terminal commands—even commands Dirac considers unsafe—and permits model-requested conversation condensing. It does not switch between Plan and Act modes, create new tasks, or enable automatic threshold-triggered condensing; that is controlled separately by Auto-condense conversations.",
	yolo: "YOLO Mode runs with maximum autonomy and bypasses confirmation prompts. It may switch from Plan to Act and disables the ask-question tool. It also permits autonomous task creation and conversation condensing. Use with extreme caution.",
	yoloPrecedence:
		"YOLO Mode takes precedence while enabled. Your Approve All setting is preserved and becomes effective again when YOLO Mode is disabled.",
	utilityDisclosure:
		"Conversation source text, Git diffs, permission policies, and complete permission-request details may be sent to this provider, which can differ from the active task provider.",
	utilityPermissionFallback:
		"Confident approvals bypass the prompt. Policy prohibitions, ambiguity, invalid output, and failures escalate to the normal permission flow; the Utility Model never rejects a request.",
	remoteBrowser:
		"A Chrome remote-debugging endpoint can grant control over open pages and browser data. Bind it only to a trusted interface and do not expose it to untrusted networks.",
	promptArtifacts:
		"Prompt metadata artifacts may contain source code, prompts, tool definitions, file paths, and conversation content. Store them securely and exclude the artifact directory from version control unless you intentionally want to commit them.",
	approvedCommandPrefix: "Choose this only when you trust this command with every possible argument.",
	approvedCommandMatching:
		"Each part of a chained command must be approved separately. File redirects are not covered; 2>&1 is ignored when matching.",
	managedSetting: "This setting is managed by your organization's remote configuration.",
} as const
