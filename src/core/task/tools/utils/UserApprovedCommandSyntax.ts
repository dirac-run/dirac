/** Tokenize only a small, literal shell subset; unsupported syntax needs approval. */
function splitByShellOperators(command: string): string[][] | undefined {
	// This tokenizer models POSIX shell syntax, not cmd.exe or PowerShell expansion.
	// The terminal's custom shell profile is not available to this static classifier.
	if (!["linux", "darwin", "freebsd", "openbsd", "netbsd", "aix", "sunos"].includes(process.platform)) return undefined
	const segments: string[][] = []
	let words: string[] = []
	let word = ""
	let started = false
	let quote = ""

	for (let i = 0; i < command.length; i++) {
		const ch = command[i]
		if (ch === "\\" && quote !== "'") {
			const next = command[++i]
			if (next === undefined || next === "\n" || next === "\r") return undefined
			// In double quotes, backslashes only escape these shell-special characters.
			if (quote === '"' && !'\\$`"'.includes(next)) word += "\\"
			word += next
			started = true
			continue
		}
		if (ch === quote) {
			quote = ""
			continue
		}
		if (quote) {
			if (quote === '"' && (ch === "$" || ch === "`")) return undefined
			word += ch
			continue
		}
		if (ch === "'" || ch === '"') {
			quote = ch
			started = true
			continue
		}
		if (ch === " " || ch === "\t") {
			if (started) words.push(word)
			word = ""
			started = false
			continue
		}
		// Only these exact, standalone stderr redirects are harmless. Never strip quoted text
		// or prefixes such as 2>/dev/null.backup or 2>&10.
		if (!started && ch === "2") {
			const redirect = command.slice(i).match(/^2(?:>\/dev\/null|>&1)(?=$|[ \t|&;])/)
			if (redirect) {
				i += redirect[0].length - 1
				continue
			}
		}
		if (ch === "|" || ch === "&" || ch === ";") {
			if (ch === "&" && command[i + 1] !== "&") return undefined
			if ((ch === "&" || ch === "|") && command[i + 1] === ch) i++
			if (started) words.push(word)
			if (words.length === 0) return undefined
			segments.push(words)
			words = []
			word = ""
			started = false
			continue
		}
		// find's standalone negation predicate is an argument, not shell pipeline negation.
		if (ch === "!" && !started && words[0] === "find" && (i + 1 === command.length || /[ \t]/.test(command[i + 1]))) {
			word = ch
			started = true
			continue
		}
		// No expansions, comments, subshells, globbing, newlines, or other redirects.
		if ("$`<>(){}[]*?~!#\n\r".includes(ch) || ch.charCodeAt(0) < 32) return undefined
		word += ch
		started = true
	}
	if (quote) return undefined
	if (started) words.push(word)
	if (words.length === 0) return undefined
	segments.push(words)
	return segments
}

/** Preserve argument boundaries for the literal subset supported by remembered commands. */
export function parseUserApprovedCommandSegments(command: string): string[][] | undefined {
	const segments = splitByShellOperators(command.trim())
	return segments?.every(([program]) => program.length > 0 && !/\s/.test(program)) ? segments : undefined
}

/** Unsupported shell syntax must never reach remembered-command matching. */
export function isSupportedUserCommandPatternSyntax(command: string): boolean {
	return parseUserApprovedCommandSegments(command) !== undefined
}

