import * as os from "os"
import * as path from "path"

/**
 * Shortens absolute paths in a command string for human-readable display.
 * - Paths under `cwd` are prefixed with `./`
 * - Paths under `homeDir` (or os.homedir()) are prefixed with `~/`
 *
 * Only the display string is modified. The actual command is never changed.
 */
export function shortenCommandForDisplay(command: string, cwd?: string): string {
    const homeDir = os.homedir()
    const resolvedCwd = cwd ? path.resolve(cwd) : undefined

    // Replace tokens that look like absolute paths
    return command.replace(/(?:^|\s)(\/[^\s"'`;&|<>{}()[\]]+)/g, (match, absPath: string) => {
        const prefix = match.slice(0, match.length - absPath.length)

        // cwd takes priority over homeDir (cwd is more specific)
        if (resolvedCwd && absPath.startsWith(resolvedCwd)) {
            const rest = absPath.slice(resolvedCwd.length)
            return prefix + "." + rest
        }

        if (absPath.startsWith(homeDir)) {
            const rest = absPath.slice(homeDir.length)
            return prefix + "~" + rest
        }

        return match
    })
}
