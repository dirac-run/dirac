// These programs have no command-execution or persistent-output options.
const SAFE_BASE_COMMANDS = new Set([
	"ls",
	"pwd",
	"whoami",
	"cat",
	"nl",
	"grep",
	"head",
	"tail",
	"cd",
	"clear",
	"echo",
	"df",
	"du",
	"ps",
	"free",
	"uptime",
	"wc",
	"stat",
	"diff",
	"cut",
	"which",
	"type",
])

// Positive option lists deliberately exclude abbreviations and unknown platform-specific options.
const SAFE_OPTIONS: Record<string, RegExp> = {
	find: /^(?:-[HLP]|-(?:name|iname|path|ipath|regex|iregex|type|xtype|size|mtime|mmin|atime|amin|ctime|cmin|newer|newermt|maxdepth|mindepth|depth|mount|xdev|follow|print|print0|printf|ls|prune|empty|readable|writable|executable|true|false|a|and|o|or|not))$/,
	sort: /^(?:-[bdfghinMrsuVz]+|-[kt].+|--(?:ignore-leading-blanks|dictionary-order|ignore-case|general-numeric-sort|human-numeric-sort|ignore-nonprinting|month-sort|numeric-sort|reverse|stable|unique|version-sort|zero-terminated)|--(?:key|field-separator)=.+)$/,
	rg: /^(?:-[ivwxFnNlLcoqsSUPauHI0]+|-[ABCm]\d+|-[egftTr]|--(?:files|hidden|no-ignore|no-ignore-vcs|no-ignore-parent|follow|line-number|no-line-number|files-with-matches|files-without-match|count|count-matches|only-matching|quiet|fixed-strings|ignore-case|case-sensitive|smart-case|word-regexp|line-regexp|multiline|multiline-dotall|pcre2|text|json|null|null-data|no-heading|heading|with-filename|no-filename|no-config|no-messages|stats|passthru)|--(?:glob|iglob|type|type-not|regexp|file|context|before-context|after-context|max-count|max-depth|encoding|replace|sort|sortr)(?:=.+)?)$/,
	file: /^(?:-[biLh]+|--(?:brief|mime|mime-type|mime-encoding|dereference|no-dereference))$/,
	uname: /^(?:-[amnprsvio]+|--(?:all|kernel-name|nodename|kernel-release|kernel-version|machine|processor|hardware-platform|operating-system))$/,
}

/** Tokenize only a small, literal shell subset; unsupported syntax needs approval. */
function splitByShellOperators(command: string): string[][] | undefined {
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

function hasOnlySafeOptions(args: string[], options: RegExp): boolean {
	return args.every((arg) => !arg.startsWith("-") || arg === "-" || arg === "--" || options.test(arg))
}

function isSafeGitCommand(args: string[]): boolean {
	const [subcommand, ...options] = args
	if (subcommand === "branch" || subcommand === "remote") {
		return options.every((option) => ["-a", "-r", "-v", "--list", "--get-url", "--show-current"].includes(option))
	}
	if (!["status", "log", "diff", "show"].includes(subcommand)) return false
	// Do not permit arbitrary git flags: output files, external diff/textconv helpers,
	// config overrides, and abbreviated long options all require approval.
	return hasOnlySafeOptions(
		options,
		/^(?:-\d+|-[purbw]+|-[UM]\d*|--(?:short|branch|porcelain|long|untracked-files|ignored|oneline|all|graph|decorate|no-decorate|name-only|name-status|stat|numstat|shortstat|summary|check|patch|no-patch|raw|relative|no-color|color|no-ext-diff|no-textconv|no-renames|no-index|exit-code|quiet|cached|staged|reverse|date-order|topo-order|first-parent|merges|no-merges)|--(?:format|pretty|date|since|until|after|before|author|committer|grep|max-count|diff-filter|untracked-files|porcelain|color|decorate)=.+)$/,
	)
}

function isSafeSedCommand(args: string[]): boolean {
	// A tiny read-only subset, not a sed-program parser. All other scripts (including
	// substitution, e/w/r commands, script files and in-place edits) need approval.
	let index = 0
	if (args[index] === "-n") index++
	if (args[index] === "-e") index++
	if (!/^(?:\d+|\$)(?:,(?:\d+|\$))?p$/.test(args[index] ?? "")) return false
	return args.slice(index + 1).every((arg) => !arg.startsWith("-"))
}

/** Keep lossy permission-parser normalization from approving unsupported raw syntax. */
export function isSupportedShellSyntax(command: string): boolean {
	const segments = splitByShellOperators(command.trim())
	return segments !== undefined && segments.every(([program]) => program.length > 0 && !/\s/.test(program))
}

/** Shared main/child auto-approval classifier; false means approval is required. */
export function isSafeCommand(command: string): boolean {
	const segments = splitByShellOperators(command.trim())
	if (!segments) return false

	return segments.every(([program, ...args]) => {
		if (program === "git") return isSafeGitCommand(args)
		if (program === "sed") return isSafeSedCommand(args)
		if (program === "date")
			return args.every((arg) => ["-u", "--utc", "--universal", "-R", "--rfc-email"].includes(arg) || arg.startsWith("+"))
		if (program === "hostname")
			return args.every((arg) =>
				/^(?:-[aAdfiIs]+|--(?:alias|all-fqdns|domain|fqdn|ip-address|all-ip-addresses|short))$/.test(arg),
			)
		if (program === "uniq") {
			// uniq's second file operand is an output file. Only attached numeric option
			// values are supported. The sole input operand must be last, since option
			// parsing may stop at it (BSD or POSIXLY_CORRECT).
			const inputIndex = args.findIndex((arg) => !arg.startsWith("-") || arg === "-")
			return (
				hasOnlySafeOptions(
					args,
					/^(?:-[cduiz]+|-[fsw]\d+|--(?:count|repeated|unique|ignore-case|zero-terminated)|--(?:skip-fields|skip-chars|check-chars)=\d+)$/,
				) &&
				(inputIndex === -1 || inputIndex === args.length - 1) &&
				!args.includes("--")
			)
		}
		if (Object.hasOwn(SAFE_OPTIONS, program)) return hasOnlySafeOptions(args, SAFE_OPTIONS[program])
		return SAFE_BASE_COMMANDS.has(program)
	})
}
