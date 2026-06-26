import fs from "fs/promises"
import * as path from "path"
import { HostProvider } from "@/hosts/host-provider"

// Resolves and creates a subdirectory under the host's global storage path.
export async function getGlobalStorageDir(...subdirs: string[]): Promise<string> {
	const fullPath = path.resolve(HostProvider.get().globalStorageFsPath, ...subdirs)
	await fs.mkdir(fullPath, { recursive: true })
	return fullPath
}
