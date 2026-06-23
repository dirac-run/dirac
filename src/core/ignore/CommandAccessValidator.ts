// Commands that read file contents and therefore need access validation
const FILE_READING_COMMANDS = [
	// Unix commands
	"cat",
	"less",
	"more",
	"head",
	"tail",
	"grep",
	"awk",
	"sed",
	// PowerShell commands and aliases
	"get-content",
	"gc",
	"type",
	"select-string",
	"sls",
]

/**
 * Validates terminal commands against an access checker.
 * Returns the first file argument that is blocked, or undefined when the command is allowed.
 */
export function findBlockedCommandArgument(
	command: string,
	validateAccess: (filePath: string) => boolean,
): string | undefined {
	const parts = command.trim().split(/\s+/)
	const baseCommand = parts[0].toLowerCase()
	if (!FILE_READING_COMMANDS.includes(baseCommand)) {
		return undefined
	}
	// Return the first argument that is an ignored file path
	return parts.slice(1).find((arg) => isFilePathArgument(arg) && !validateAccess(arg))
}

// True when an argument looks like a file path rather than a flag or PowerShell parameter
function isFilePathArgument(arg: string): boolean {
	if (arg.startsWith("-") || arg.startsWith("/")) {
		return false // Skip command flags/options (both Unix and PowerShell style)
	}
	if (arg.includes(":")) {
		return false // Ignore PowerShell parameter names
	}
	return true
}
