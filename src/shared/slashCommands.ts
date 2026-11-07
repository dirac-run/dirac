export interface SlashCommand {
	name: string
	description?: string
	section?: "default" | "custom" | "skill"
	cliCompatible?: boolean
}

export const BASE_SLASH_COMMANDS: SlashCommand[] = [
	{
		name: "agents",
		description: "Show a frozen active-agent snapshot locally (not sent to the model)",
		section: "default",
		cliCompatible: true,
	},
	{
		name: "smol",
		description: "Condenses your current context window",
		section: "default",
		cliCompatible: true,
	},
	{
		name: "newrule",
		description: "Create a new Dirac rule based on your conversation",
		section: "default",
		cliCompatible: true,
	},
	{
		name: "askDirac",
		description: "Get help with Dirac's internal workings and source code",
		section: "default",
		cliCompatible: true,
	},
	{
		name: "help",
		description: "Learn how to use Dirac CLI",
		section: "default",
		cliCompatible: true,
	},
	{
		name: "reloadtools",
		description: "Reload custom tools from disk",
		section: "default",
		cliCompatible: true,
	},
]

// VS Code-only slash commands
export const VSCODE_ONLY_COMMANDS: SlashCommand[] = []

// CLI-only slash commands. Most are handled locally; /goal routes through the interactive Controller.
export const CLI_ONLY_COMMANDS: SlashCommand[] = [
	{
		name: "goal",
		description: "Start a fresh interactive Goal",
		section: "default",
		cliCompatible: true,
	},
	{
		name: "settings",
		description: "Change API provider, auto-approve, and feature settings",
		section: "default",
		cliCompatible: true,
	},
	{
		name: "providers",
		description: "Switch between configured API providers",
		section: "default",
		cliCompatible: true,
	},
	{
		name: "models",
		description: "Change the model used for the current mode",
		section: "default",
		cliCompatible: true,
	},
	{
		name: "history",
		description: "Browse and search task history",
		section: "default",
		cliCompatible: true,
	},
	{
		name: "agent",
		description: "Read agent transcripts in a separate, read-only view",
		section: "default",
		cliCompatible: true,
	},
	{
		name: "clear",
		description: "Clear the current task and start fresh",
		section: "default",
		cliCompatible: true,
	},
	{
		name: "exit",
		description: "Alternative to Ctrl+C",
		section: "default",
		cliCompatible: true,
	},
	{
		name: "q",
		description: "Alternative to Ctrl+C",
		section: "default",
		cliCompatible: true,
	},
	{
		name: "skills",
		description: "View and manage installed skills",
		section: "default",
		cliCompatible: true,
	},
	{
		name: "usage",
		description: "View ChatGPT subscription usage",
		section: "default",
		cliCompatible: true,
	},
	{
		name: "quiet",
		description: "Toggle card bodies for future tool output",
		section: "default",
		cliCompatible: true,
	},
	{
		name: "fast",
		description: "Enable Fast Mode for the current provider and model",
		section: "default",
		cliCompatible: true,
	},
]
