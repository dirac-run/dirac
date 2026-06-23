import fs from "fs/promises"

// Atomically write data to a file using temp file + rename pattern.
// Prevents readers from seeing partial data by writing to a temp file first, then renaming.
export async function atomicWriteFile(filePath: string, data: string): Promise<void> {
	const tmpPath = `${filePath}.tmp.${Date.now()}.${Math.random().toString(36).substring(7)}.json`
	try {
		await fs.writeFile(tmpPath, data, "utf8")
		await fs.rename(tmpPath, filePath)
	} catch (error) {
		fs.unlink(tmpPath).catch(() => {})
		throw error
	}
}
