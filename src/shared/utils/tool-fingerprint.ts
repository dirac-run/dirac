import fs from "fs/promises"

export interface ToolFingerprintEntry {
	id: string
	name: string
	description?: string
	source: string
	modulePath: string
	sourceVersion?: string
}

export async function fingerprintAvailableTools(
	tools: Array<{ id: string; name: string; source: string; modulePath: string; description?: string }>,
): Promise<string> {
	const entries = await Promise.all(
		tools.map(async (tool) => {
			let sourceVersion: string | undefined
			try {
				const stat = await fs.stat(tool.modulePath)
				sourceVersion = `${stat.mtimeMs}:${stat.size}`
			} catch {
				sourceVersion = undefined
			}

			return {
				id: tool.id,
				name: tool.name,
				description: tool.description,
				source: tool.source,
				modulePath: tool.modulePath,
				sourceVersion,
			} satisfies ToolFingerprintEntry
		}),
	)

	return JSON.stringify(
		entries.sort((a, b) =>
			`${a.source}:${a.id}:${a.name}:${a.modulePath}`.localeCompare(`${b.source}:${b.id}:${b.name}:${b.modulePath}`),
		),
	)
}
