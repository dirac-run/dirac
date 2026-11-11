import type { SandboxProfileDraft } from "./settings-presentation"

/** Each row owns its labels: the choices are not a universal permission scale. */
export const SANDBOX_CAPABILITY_ROWS = [
	{
		key: "workspace", label: "Workspace", help: "Access to workspace folders.",
		options: [{ value: "read-only", label: "Read-only" }, { value: "read-write", label: "Read & write" }],
	},
	{
		key: "hostFiles", label: "Other host files", help: "Selected runtime paths and explicit folder grants remain available when other host files are blocked.",
		options: [{ value: "blocked", label: "Blocked" }, { value: "read-only", label: "Read-only" }],
	},
	{
		key: "network", label: "Network", help: "Network blocking does not block AF_UNIX/local IPC.",
		options: [{ value: "blocked", label: "Blocked" }, { value: "allowed", label: "Allowed" }],
	},
	{
		key: "packageCaches", label: "Package caches", help: "Extra read/write grants for precise cache directories, never implicit home access. No extra access does not block access already granted by workspace, host or folder rules.",
		options: [{ value: "blocked", label: "No extra access" }, { value: "allowed", label: "Read & write" }],
	},
] as const

export type SandboxCapabilityKey = (typeof SANDBOX_CAPABILITY_ROWS)[number]["key"]
export type SandboxFolderAccess = "read-only" | "read-write" | "blocked"
export interface SandboxAdditionalFolder {
	path: string
	access: SandboxFolderAccess
}

const lines = (value: string): string[] => value.split("\n").filter(Boolean)

export function sandboxCapabilityValue(draft: SandboxProfileDraft, key: SandboxCapabilityKey): string {
	switch (key) {
		case "workspace": return draft.workspace
		case "hostFiles": return draft.base === "selected" ? "blocked" : "read-only"
		case "network": return draft.network === "deny" ? "blocked" : "allowed"
		case "packageCaches": return lines(draft.caches).length ? "allowed" : "blocked"
	}
}

/** Modify only the chosen capability; advanced fields and unrelated folder grants survive unchanged. */
export function updateSandboxCapability(draft: SandboxProfileDraft, key: SandboxCapabilityKey, value: string, cachePaths?: readonly string[]): SandboxProfileDraft {
	const row = SANDBOX_CAPABILITY_ROWS.find((entry) => entry.key === key)!
	if (!row.options.some((option) => option.value === value)) throw new Error(`Invalid ${row.label} capability: ${value}`)
	switch (key) {
		case "workspace": return { ...draft, workspace: value }
		case "hostFiles": return { ...draft, base: value === "blocked" ? "selected" : "broad-read" }
		case "network": return { ...draft, network: value === "blocked" ? "deny" : "allow" }
		case "packageCaches": {
			if (value === "blocked") return { ...draft, caches: "" }
			const paths = cachePaths ? [...cachePaths] : lines(draft.caches)
			if (!paths.length || paths.some((path) => !path.trim() || path === "/" || path === "~/")) throw new Error("Configure precise package cache directories before allowing cache access")
			return { ...draft, caches: paths.join("\n") }
		}
	}
}

/** Reading the flat view never normalizes or rewrites the saved advanced path lists. */
export function sandboxAdditionalFolders(draft: SandboxProfileDraft): SandboxAdditionalFolder[] {
	return [
		...lines(draft.readable).map((path): SandboxAdditionalFolder => ({ path, access: "read-only" })),
		...lines(draft.writable).map((path): SandboxAdditionalFolder => ({ path, access: "read-write" })),
		...lines(draft.blocked).map((path): SandboxAdditionalFolder => ({ path, access: "blocked" })),
	]
}

/** Called only after an actual folder edit, not when opening or saving an unchanged editor. */
export function updateSandboxAdditionalFolders(draft: SandboxProfileDraft, folders: readonly SandboxAdditionalFolder[]): SandboxProfileDraft {
	return {
		...draft,
		readable: folders.filter((folder) => folder.access === "read-only").map((folder) => folder.path).join("\n"),
		writable: folders.filter((folder) => folder.access === "read-write").map((folder) => folder.path).join("\n"),
		blocked: folders.filter((folder) => folder.access === "blocked").map((folder) => folder.path).join("\n"),
	}
}
