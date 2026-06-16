const SAFE_BASE_COMMANDS = [
    "ls",
    "pwd",
    "date",
    "whoami",
    "uname",
    "cat",
    "grep",
    "find",
    "head",
    "tail",
    "cd",
    "clear",
    "echo",
    "hostname",
    "df",
    "du",
    "ps",
    "free",
    "uptime",
    "wc",
    "sort",
    "uniq",
    "file",
    "stat",
    "diff",
    "rg",
    "cut",
    "which",
    "type",
    "sed",
    "awk",
]

const SAFE_GIT_SUBCOMMANDS = ["status", "log", "diff", "branch", "show", "remote"]

/**
 * Splits a command string by shell operators (|, ||, &&, ;, newline) while
 * respecting single and double quotes. This prevents characters inside quoted
 * strings (e.g. regex alternation `\|` in grep patterns) from being treated
 * as shell pipe operators.
 */
function splitByShellOperators(command: string): string[] {
    const segments: string[] = []
    let current = ""
    let inSingleQuote = false
    let inDoubleQuote = false

    for (let i = 0; i < command.length; i++) {
        const ch = command[i]

        // Backslash escapes the next character outside single quotes
        if (ch === "\\" && !inSingleQuote) {
            current += ch
            if (i + 1 < command.length) {
                i++
                current += command[i]
            }
            continue
        }

        if (ch === "'" && !inDoubleQuote) {
            inSingleQuote = !inSingleQuote
            current += ch
        } else if (ch === '"' && !inSingleQuote) {
            inDoubleQuote = !inDoubleQuote
            current += ch
        } else if (!inSingleQuote && !inDoubleQuote) {
            // Check multi-char operators first
            if (ch === "|" && i + 1 < command.length && command[i + 1] === "|") {
                segments.push(current)
                current = ""
                i++ // skip second |
            } else if (ch === "&" && i + 1 < command.length && command[i + 1] === "&") {
                segments.push(current)
                current = ""
                i++ // skip second &
            } else if (ch === "|" || ch === ";" || ch === "\n") {
                segments.push(current)
                current = ""
            } else {
                current += ch
            }
        } else {
            current += ch
        }
    }

    if (current) {
        segments.push(current)
    }

    return segments
}

/**
 * Returns true if the string contains a shell redirection operator (`>` or `<`)
 * outside of quoted contexts. Rejects commands with unmatched quotes as a
 * defensive measure (they are either syntax errors or potential bypass attempts).
 */
function containsRedirectionOutsideQuotes(str: string): boolean {
    let inSingleQuote = false
    let inDoubleQuote = false

    for (let i = 0; i < str.length; i++) {
        const ch = str[i]

        // Backslash escapes the next character outside single quotes
        if (ch === "\\" && !inSingleQuote) {
            i++ // skip escaped char
            continue
        }

        if (ch === "'" && !inDoubleQuote) {
            inSingleQuote = !inSingleQuote
        } else if (ch === '"' && !inSingleQuote) {
            inDoubleQuote = !inDoubleQuote
        } else if (!inSingleQuote && !inDoubleQuote) {
            if (ch === ">" || ch === "<") {
                return true
            }
        }
    }

    // Unmatched quotes → reject as suspicious
    if (inSingleQuote || inDoubleQuote) {
        return true
    }

    return false
}

/**
 * Checks if a CLI command is considered "harmless" and safe for auto-approval.
 * This function handles piped commands and rejects output redirection to disk.
 *
 * @param command The CLI command to check
 * @returns true if the command is deemed safe, false otherwise
 */
export function isSafeCommand(command: string): boolean {
    let normalized = command.trim()

    // Strip stderr redirections globally (safe: they don't write to disk)
    // Must happen before the > / < check to avoid false positives
    normalized = normalized.replace(/\b2>\/dev\/null/g, "").trim()
    normalized = normalized.replace(/\b2>&1/g, "").trim()

    // 1. Reject output redirection (avoids disk writes) and input redirection
    if (containsRedirectionOutsideQuotes(normalized)) {
        return false
    }

    // 2. Reject command substitution
    if (normalized.includes("$(") || normalized.includes("`")) {
        return false
    }

    // 3. Split by common shell operators to check each part
    // Handles |, &&, ||, ;
    const segments = splitByShellOperators(normalized)

    for (const segment of segments) {
        const trimmed = segment.trim()
        if (!trimmed) {
            continue
        }

        const parts = trimmed.split(/\s+/)
        const baseCommand = parts[0].toLowerCase()

        // 4. Special handling for git to only allow read-only operations
        if (baseCommand === "git") {
            if (parts.length < 2) {
                return false
            }
            const subcommand = parts[1].toLowerCase()
            if (!SAFE_GIT_SUBCOMMANDS.includes(subcommand)) {
                return false
            }

            // Restrict branch and remote to listing only
            if (subcommand === "branch" || subcommand === "remote") {
                const allowedFlags = ["-a", "-r", "-v", "--list", "--get-url"]
                for (let i = 2; i < parts.length; i++) {
                    if (!allowedFlags.includes(parts[i])) {
                        return false
                    }
                }
            }
        } else if (baseCommand === "find") {
            // 5. Special handling for find to block dangerous flags
            const dangerousFlags = ["-delete", "-exec", "-execdir", "-ok", "-okdir"]
            if (parts.some((part) => dangerousFlags.some((flag) => part.toLowerCase().startsWith(flag)))) {
                return false
            }
        } else if (baseCommand === "sed") {
            // 6. Special handling for sed to block in-place edit flags
            if (
                parts.some((part) => {
                    return /^--in-place/.test(part) || /^-[^-]*i/.test(part)
                })
            ) {
                return false
            }
        } else if (baseCommand === "sort") {
            // 7. Special handling for sort to block output flag
            if (
                parts.some((part) => {
                    const lowerPart = part.toLowerCase()
                    return lowerPart === "-o" || lowerPart.startsWith("-o") || lowerPart.startsWith("--output")
                })
            ) {
                return false
            }
        } else if (!SAFE_BASE_COMMANDS.includes(baseCommand)) {
            // 8. Check against general safe list
            return false
        }
    }

    return true
}
