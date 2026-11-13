import { classify } from "braket-cli"
import { parse } from "shell-quote"

export const COMMAND_CAPABILITY_CATEGORIES = [
	"filesystem",
	"network",
	"processes",
	"execution",
	"credentials",
	"software",
	"configuration",
	"devices",
	"remote_resources",
	"system",
] as const

export type CommandCapabilityCategory = (typeof COMMAND_CAPABILITY_CATEGORIES)[number]
export type CommandCapabilityAccess = 1 | 3 | 7
export interface CommandCapabilityDeficit {
	category: CommandCapabilityCategory
	index: number
	access: CommandCapabilityAccess
}

/** Ten three-bit fields, in COMMAND_CAPABILITY_CATEGORIES order. */
export const DEFAULT_COMMAND_CAPABILITIES = [3, 0, 3, 0, 0, 3, 3, 1, 0, 3].reduce(
	(packed, level, index) => packed | (level << (index * 3)),
	0,
)

/** Classify the exact normalized command that will execute; -1 is unknown. */
export function classifyCommandCapabilities(command: string): number {
	// Braket models Bash, not cmd.exe or PowerShell. In particular, Bash comments
	// can hide command separators that cmd.exe will execute.
	if (!["linux", "darwin", "freebsd", "openbsd", "netbsd", "aix", "sunos"].includes(process.platform)) return -1
	const required = classify(command)
	if (required === -1) return -1

	// braket-cli 0.1.0 underclassifies Git's external diff/textconv and input
	// filters as filesystem reads. Preserve shell word boundaries/quote removal
	// when recognizing these forms, including within compound commands.
	const tokens = parse(command)
	const includesGit = tokens.some((token) => typeof token === "string" && /(?:^|\/)git$/.test(token))
	if (includesGit && tokens.some((token) => token === "hash-object" || token === "--ext-diff" || token === "--textconv")) return -1
	return required
}

/** Unknown commands have no grantable capability set. */
export function getMissingCommandCapabilities(
	required: number,
	grants = DEFAULT_COMMAND_CAPABILITIES,
): CommandCapabilityDeficit[] | undefined {
	if (required === -1) return undefined
	return COMMAND_CAPABILITY_CATEGORIES.flatMap((category, index) => {
		const access = (required >>> (index * 3)) & 7
		const allowed = (grants >>> (index * 3)) & 7
		return access > allowed ? [{ category, index, access: access as CommandCapabilityAccess }] : []
	}).sort((left, right) => right.access - left.access || left.index - right.index)
}

/** Grants augment rather than replace the default policy. */
export function mergeCommandCapabilities(base: number, grants: number): number {
	if (base === -1 || grants === -1) throw new Error("Unknown command capabilities cannot be granted")
	return base | grants
}

/** Shared main/child auto-approval policy; unknown always requires approval. */
export function isSafeCommand(command: string, grants = DEFAULT_COMMAND_CAPABILITIES): boolean {
	const missing = getMissingCommandCapabilities(classifyCommandCapabilities(command), grants)
	return missing !== undefined && missing.length === 0
}
