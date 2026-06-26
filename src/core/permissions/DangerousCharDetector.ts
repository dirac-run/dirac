import type { ShellOperatorMatch } from "./types"

const LINE_SEPARATOR_REGEX = /[\n\r\u2028\u2029\u0085]/
const LINE_SEPARATOR_DESCRIPTIONS: Record<string, ShellOperatorMatch> = {
	"\n": { operator: "\\n", description: "newline (command separator)" },
	"\r": { operator: "\\r", description: "carriage return (potential command separator)" },
	"\u2028": { operator: "U+2028", description: "unicode line separator" },
	"\u2029": { operator: "U+2029", description: "unicode paragraph separator" },
	"\u0085": { operator: "U+0085", description: "unicode next line" },
}

/**
 * Detects dangerous characters outside of quoted strings.
 *
 * Newlines/carriage returns are safe inside ANY quotes (they become literal characters).
 * Backticks are only safe inside SINGLE quotes because double quotes still allow command substitution.
 *
 * Examples:
 *   gh pr comment 123 --body "line1\nline2"  -> ALLOWED (newline in quotes)
 *   gh pr comment 123\nrm -rf /              -> BLOCKED (newline outside quotes)
 *   echo `date`                              -> BLOCKED (backtick outside quotes)
 *   echo "hello `date`"                      -> BLOCKED (backtick in double quotes - executes!)
 *   echo 'hello `date`'                      -> ALLOWED (backtick in single quotes - literal)
 */
export class DangerousCharDetector {
	/** Returns ShellOperatorMatch if dangerous chars found outside appropriate quotes, null otherwise. */
	detect(command: string): ShellOperatorMatch | null {
		let inSingleQuote = false
		let inDoubleQuote = false
		let isEscaped = false

		for (let i = 0; i < command.length; i++) {
			const char = command[i]

			// If previous char was an unescaped backslash, this char is escaped
			if (isEscaped) {
				isEscaped = false
				continue
			}

			// Escape sequence (only outside single quotes - in single quotes backslashes are literal)
			if (char === "\\" && !inSingleQuote) {
				isEscaped = true
				continue
			}

			// Double quotes - track them to know when single quotes are literal
			if (char === '"' && !inSingleQuote) {
				inDoubleQuote = !inDoubleQuote
				continue
			}

			// Single quotes - only toggle when NOT inside double quotes (inside double quotes they're literal)
			if (char === "'" && !inDoubleQuote) {
				inSingleQuote = !inSingleQuote
				continue
			}

			const inAnyQuote = inSingleQuote || inDoubleQuote

			// Newlines and carriage returns outside ANY quotes are command separators
			if (!inAnyQuote && LINE_SEPARATOR_REGEX.test(char)) {
				return LINE_SEPARATOR_DESCRIPTIONS[char]
			}

			// Backticks outside SINGLE quotes only (in double quotes they ARE executed as command substitution)
			if (char === "`" && !inSingleQuote) {
				return { operator: "`", description: "command substitution (backtick)" }
			}
		}

		return null
	}
}
