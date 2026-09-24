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
export function findBlockedCommandArgument(command: string, validateAccess: (filePath: string) => boolean): string | undefined {
	const parts = command.trim().split(/\s+/)
	const baseCommand = parts[0].toLowerCase()
	if (!FILE_READING_COMMANDS.includes(baseCommand)) {
		return undefined
	}
	// Return the first argument that is an ignored file path
	return parts.slice(1).find((arg) => isFilePathArgument(arg) && !validateAccess(arg))
}

/** A drive-qualified Windows path: C:\dir\file, d:/dir/file, C:file.txt. */
const WINDOWS_DRIVE_PREFIX = /^[A-Za-z]:/

// True when an argument looks like a file path rather than a flag or PowerShell parameter
function isFilePathArgument(arg: string): boolean {
	// Must precede the colon rule below. Every default PowerShell provider drive has a
	// multi-character name (Env:, HKLM:, Variable:, Cert:), so a single letter before the
	// colon is unambiguously a filesystem drive and never a parameter name.
	if (WINDOWS_DRIVE_PREFIX.test(arg)) {
		return true
	}
	if (arg.startsWith("-")) {
		return false // Command flags, including PowerShell -Parameter:Value
	}
	if (arg.startsWith("/")) {
		// cmd.exe and PowerShell legacy switches (/s, /i) on Windows; absolute paths elsewhere.
		return process.platform !== "win32"
	}
	if (arg.includes(":")) {
		return false // PowerShell parameter names, provider drives, URLs
	}
	return true
}
