import {
	askDiracToolResponse,
	condenseToolResponse,
	newRuleToolResponse,
	newTaskToolResponse,
} from "../prompts/commands"

// Builtin slash commands recognized by the parser.
export const SUPPORTED_DEFAULT_COMMANDS = [
	"newtask",
	"smol",
	"compact",
	"newrule",
	"permissions",
	"askDirac",
	"reloadtools",
]

// Regex patterns to extract content from different XML tags.
export const TAG_PATTERNS = [
	{ tag: "task", regex: /<task>([\s\S]*?)<\/task>/i },
	{ tag: "feedback", regex: /<feedback>([\s\S]*?)<\/feedback>/i },
	{ tag: "answer", regex: /<answer>([\s\S]*?)<\/answer>/i },
	{ tag: "user_message", regex: /<user_message>([\s\S]*?)<\/user_message>/i },
]

// Regex to find slash commands anywhere in text (not just at the beginning).
// (^|\s) ensures the slash is at start or preceded by whitespace, avoiding
// false matches in URLs (http://example.com/newtask) and file paths (foo/bar).
// Only ONE slash command per message is processed (first match found).
export const SLASH_COMMAND_IN_TEXT_REGEX = /(^|\s)\/([a-zA-Z0-9_.:@-]+)(?=\s|$)/

// Builds the replacement-content map for builtin commands (askDirac needs paths).
export function buildCommandReplacements(
	extensionPath: string | undefined,
	sourceDir: string,
): Record<string, string | Promise<string>> {
	return {
		newtask: newTaskToolResponse(),
		smol: condenseToolResponse(),
		compact: condenseToolResponse(),
		newrule: newRuleToolResponse(),
		askDirac: askDiracToolResponse(extensionPath, sourceDir),
		reloadtools: "__RELOAD_TOOLS__",
	}
}
