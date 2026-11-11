/** Portable settings syntax, not proof that a path exists or is safe on the execution host. */
export type SandboxPathStyle = "posix" | "windows-drive"

export function sandboxPathStyle(value: string): SandboxPathStyle {
	if (/^[A-Za-z]:[\\/]/.test(value)) return "windows-drive"
	return "posix"
}

/** UNC, NT/device namespaces, ADS, DOS aliases and ambiguous Windows spellings are unsupported. */
export function validateSandboxPath(value: unknown): string {
	if (typeof value !== "string" || !value.trim() || /[\x00-\x1f\x7f*?\[\]{}$`]/.test(value))
		throw new Error("Sandbox paths must be explicit absolute paths without globs or placeholders")
	if (sandboxPathStyle(value) === "windows-drive") {
		if (/[^\x20-\x7e]/.test(value) || /[:<>"|~]/.test(value.slice(2)))
			throw new Error("Unsupported Windows sandbox path: use an ASCII drive-absolute path without aliases or streams")
		const components = value.slice(3).split(/[\\/]/)
		if (components.some((part, index) =>
			(!part && index < components.length - 1) || part === "." || part === ".." || /[. ]$/.test(part) ||
			/^(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(part)))
			throw new Error("Unsupported Windows sandbox path component")
		return value
	}
	if ((!value.startsWith("/") && !value.startsWith("~/")) || value.startsWith("//") || value.includes("\\"))
		throw new Error("Sandbox paths require POSIX absolute or ~/ paths, or Windows drive-absolute paths; UNC and device paths are unsupported")
	return value
}
