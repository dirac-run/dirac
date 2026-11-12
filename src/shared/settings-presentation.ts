import type { CustomSandboxProfile } from "./SandboxSettings"

export const SETTINGS_DESTINATION_IDS = [
	"models-api",
	"utility-model",
	"approvals",
	"responses-context",
	"running-tasks",
	"tools",
	"terminal",
	"sandbox",
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
	sandbox: {
		id: "sandbox",
		label: "Sandbox",
		compactLabel: "Sandbox",
		question: "How should commands use native sandbox execution?",
		shortHelp: "Configure command profiles, fallback, and host availability",
		webviewTooltip: "Configure native command execution and inspect host limitations.",
		keywords: ["sandbox", "isolation", "fallback", "profile", "bubblewrap", "seatbelt", "availability"],
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
	planModel: "Main model for exploring code and planning changes.",
	actModel: "Main model for implementing changes and running tools.",
	planAndActModel: "Main model for both planning and implementing changes.",
	utilityModel: "Model for the supporting operations you enable below.",
	subagentRoles: "Subagents are helpers your main model can delegate work to. They use the current model by default. For alternatives, select a model and enable a role. Your main model sees each enabled role's name and description and decides when to use it; the subagent runs with your saved model settings.",
	subagentRoleDescription: "Briefly describe when to use this role. Your main model uses this description to decide when to delegate to it.",
	sandboxCustom: "Available controls depend on the execution host's native backend, not the UI computer. Unsupported or invalid policies always block commands and cannot be discarded through fallback. Recognized prelaunch setup/availability failures for a supported policy may run unsandboxed only with explicit fallback authorization. Approvals never override restrictions. Network deny is not a promise to isolate every local IPC service.",
	sandboxPaths: "Paths must belong to the execution host: POSIX absolute or ~/ paths on Linux/macOS; ASCII drive-absolute paths on Windows. Relative paths, globs and placeholders are unsupported. Windows UNC/device paths, streams, DOS aliases and reparse points are unsupported. Sources must exist; aliases, canonical conflicts and unsupported controls are checked before launch. Selected grants the backend's explicit system-runtime baseline plus workspace and saved grants, not all host files. Blocked rules take precedence. Linux private temp is an empty per-launch tmpfs; macOS/Windows use a unique host-backed directory under the configured parent, not a tmpfs. Saved custom paths are never silently remapped across hosts. No implicit host environment passthrough.",
	sandboxCreate: "Built-in profiles are immutable. New custom profiles start from Workspace: selected system runtime paths, read/write workspace, network allowed, private /tmp, and PATH/HOME/LANG passthrough. Package caches require explicit directories; no home directory is granted implicitly. Customize or duplicate copies the saved policy; Advanced preserves all detailed rules.",
	sandboxEnabled: "Off bypasses native sandbox launch and uses normal command execution. Changes affect future launches only, not running commands.",
	sandboxFallback: "Authorize unsandboxed execution only for recognized setup or availability failures before a command starts. Never retries policy denials or commands that may have started. Off by default.",
	sandboxDefault: "Default is permissive: no intentional additional filesystem or network restrictions. It does not provide meaningful isolation.",
	sandboxCoverage: "Command execution only. Host-side file operations, custom tools, and other trusted services are not sandboxed. Existing command approvals still apply.",
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

export const SANDBOX_PROFILE_GROUPS = ["Identity", "Filesystem", "Network", "Environment"] as const

/** Shared form fields keep CLI and editor policy drafts identical; no draft is persisted until Save. */
export const SANDBOX_PROFILE_FIELDS = [
	{ key: "name", label: "Name", group: "Identity", help: "A unique name; Default is reserved." },
	{ key: "description", label: "Description", group: "Identity", help: "Optional note about this profile's intended use." },
	{ key: "base", label: "Filesystem base", group: "Filesystem", help: "Starting read access, before workspace and explicit grants.", options: ["selected", "broad-read"], optionLabels: { selected: "System runtime paths", "broad-read": "Entire host filesystem (read-only)" } },
	{ key: "workspace", label: "Workspace access", group: "Filesystem", help: "Access to all workspace folders.", options: ["read-only", "read-write"], optionLabels: { "read-only": "Read only", "read-write": "Read and write" } },
	{ key: "readable", label: "Readable paths", group: "Filesystem", help: "Extra read-only access. One absolute or ~/ path per line." },
	{ key: "writable", label: "Writable paths", group: "Filesystem", help: "Extra read/write access. One absolute or ~/ path per line." },
	{ key: "blocked", label: "Blocked paths", group: "Filesystem", help: "Hidden paths, including children of otherwise allowed paths. One per line." },
	{ key: "caches", label: "Writable cache paths", group: "Filesystem", help: "Host cache directories with read/write access. One path per line." },
	{ key: "temporaryDirectory", label: "Private temporary directory", group: "Filesystem", help: "Linux: per-launch tmpfs at this path. macOS/Windows: parent of a unique host-backed directory. Must not overlap grants. Sets TMPDIR, TMP and TEMP." },
	{ key: "network", label: "Network", group: "Network", help: "Deny blocks network access, not AF_UNIX/local IPC.", options: ["deny", "allow"], optionLabels: { deny: "Deny network access", allow: "Allow network access" } },
	{ key: "passthrough", label: "Environment passthrough names", group: "Environment", help: "Host variable names to inherit, one per line. No other host variables pass through implicitly." },
	{ key: "overrides", label: "Environment overrides (NAME=value; avoid secrets)", group: "Environment", help: "One NAME=value per line. Stored in plaintext settings, not a secret store." },
] as const

export function sandboxProfileSummary(profile: CustomSandboxProfile): string {
	return `${profile.filesystem.base === "broad-read" ? "Host read access" : "Selected read access"} · workspace ${profile.filesystem.workspace === "read-write" ? "read/write" : "read-only"} · network ${profile.network === "deny" ? "denied" : "allowed"}`
}

/** These exact host messages are already explained by the overview and Default warning. Keep all unique details. */
export function sandboxHostLimitations(limitations: readonly string[]): string[] {
	const repeated = new Set([
		"Default is permissive and provides no meaningful isolation.",
		"Default is permissive and provides no meaningful isolation; filesystem and network remain accessible.",
		"Only commands are covered; host file tools, custom tools and services remain trusted.",
		"Custom controls cover command descendants only; host file tools, custom tools and services remain trusted.",
	])
	return [...new Set(limitations)].filter((line) => !repeated.has(line))
}
export type SandboxProfileDraft = Record<(typeof SANDBOX_PROFILE_FIELDS)[number]["key"], string>
export function sandboxProfileDraft(profile?: CustomSandboxProfile, duplicate = false): SandboxProfileDraft {
	return {
		name: profile ? `${profile.name}${duplicate ? " copy" : ""}` : "", description: profile?.description ?? "",
		base: profile?.filesystem.base ?? "selected", workspace: profile?.filesystem.workspace ?? "read-write",
		readable: profile?.filesystem.readable.join("\n") ?? "", writable: profile?.filesystem.writable.join("\n") ?? "",
		blocked: profile?.filesystem.blocked.join("\n") ?? "", caches: profile?.filesystem.caches.join("\n") ?? "",
		temporaryDirectory: profile?.temporaryDirectory ?? "/tmp", network: profile?.network ?? "allow",
		passthrough: profile?.environment.passthrough.join("\n") ?? "PATH\nHOME\nLANG",
		overrides: Object.entries(profile?.environment.overrides ?? {}).map(([key, value]) => `${key}=${value}`).join("\n"),
	}
}
export function sandboxProfileFromDraft(draft: SandboxProfileDraft, id: string, revision: number): CustomSandboxProfile {
	const lines = (value: string) => value.split("\n").filter(Boolean)
	const overrides: Record<string, string> = Object.create(null)
	for (const line of lines(draft.overrides)) {
		const equals = line.indexOf("=")
		if (equals < 1) throw new Error("Environment overrides must use NAME=value, one per line")
		const name = line.slice(0, equals)
		if (Object.hasOwn(overrides, name)) throw new Error(`Duplicate environment override: ${name}`)
		overrides[name] = line.slice(equals + 1)
	}
	return {
		id, revision, kind: "custom", name: draft.name.trim(), description: draft.description,
		filesystem: {
			base: draft.base as "selected" | "broad-read", workspace: draft.workspace as "read-only" | "read-write",
			readable: lines(draft.readable), writable: lines(draft.writable), blocked: lines(draft.blocked), caches: lines(draft.caches)
		},
		temporaryDirectory: draft.temporaryDirectory, network: draft.network as "allow" | "deny",
		environment: { passthrough: lines(draft.passthrough), overrides },
	}
}
