import * as path from "node:path"
import { formatResponse } from "@core/formatResponse"
import { resolveWorkspacePath } from "@core/workspace"
import { extractFileContent } from "@integrations/misc/extract-file-content"
import { processFilesIntoText } from "@integrations/misc/extract-text"
import { countTextFileLines, readTextFileWindow } from "@integrations/misc/read-text-file-window"
import { listFiles } from "@services/glob/list-files"
import * as fs from "fs/promises"
import { HostProvider } from "@/hosts/host-provider"
import type { IWorkspaceTrait } from "../../interfaces/IToolEnvironment"
import type { TaskConfig } from "../../types/TaskConfig"

// Builds the workspace trait — file I/O, path resolution, and listing.
export function buildWorkspaceTrait(config: TaskConfig): IWorkspaceTrait {
	const assertReadAccess = (filePath: string): void => {
		if (!config.services.diracIgnoreController.validateAccess(path.resolve(filePath))) {
			throw new Error(formatResponse.diracIgnoreError(filePath))
		}
	}

	return {
		resolvePath: async (relPath) => {
			const result = resolveWorkspacePath(config, relPath, "SurfaceAdapter.resolvePath")
			return typeof result === "string" ? { absolutePath: result, displayPath: relPath } : result
		},
		readFile: async (path) => {
			assertReadAccess(path)
			return await fs.readFile(path, "utf8")
		},
		readTextFileWindow: async (path, options) => {
			assertReadAccess(path)
			return await readTextFileWindow(path, options)
		},
		countTextFileLines: async (path, signal) => {
			assertReadAccess(path)
			return await countTextFileLines(path, signal)
		},
		readRichFile: async (path) => {
			assertReadAccess(path)
			const supportsImages = config.model.info.supportsImages ?? false
			return await extractFileContent(path, supportsImages)
		},
		formatAttachedFiles: async (paths) => await processFilesIntoText(paths, assertReadAccess),
		getFileInfo: async (path) => {
			try {
				const stats = await fs.stat(path)
				return { size: stats.size, isFile: stats.isFile(), exists: true }
			} catch {
				return { size: 0, isFile: false, exists: false }
			}
		},
		listFiles: async (path, recursive, limit) => await listFiles(path, recursive, limit),
		writeFile: async (path, content) =>
			await config.callbacks.withMutationAuthorization(config.toolUse?.name, () => fs.writeFile(path, content, "utf8")),
		saveOpenDocumentIfDirty: async (options) => {
			await config.callbacks.withMutationAuthorization(config.toolUse?.name, async () => {
				await HostProvider.workspace.saveOpenDocumentIfDirty(options)
			})
		},
	}
}
