import { resolveWorkspacePath } from "@core/workspace"
import { extractFileContent } from "@integrations/misc/extract-file-content"
import { listFiles } from "@services/glob/list-files"
import * as fs from "fs/promises"
import { HostProvider } from "@/hosts/host-provider"
import type { ITelemetryTrait, IWorkspaceTrait } from "../../interfaces/IToolEnvironment"
import type { TaskConfig } from "../../types/TaskConfig"

// Builds the telemetry trait — custom metadata capture via a mutable holder.
export function buildTelemetryTrait(metadataHolder: { customMetadata: Record<string, any> }): ITelemetryTrait {
	return {
		captureCustomMetadata: (metadata) => {
			metadataHolder.customMetadata = { ...metadataHolder.customMetadata, ...metadata }
		},
	}
}

// Builds the workspace trait — file I/O, path resolution, and listing.
export function buildWorkspaceTrait(config: TaskConfig): IWorkspaceTrait {
	return {
		resolvePath: async (relPath) => {
			const result = resolveWorkspacePath(config, relPath, "SurfaceAdapter.resolvePath")
			return typeof result === "string" ? { absolutePath: result, displayPath: relPath } : result
		},
		readFile: async (path) => await fs.readFile(path, "utf8"),
		readRichFile: async (path) => {
			const supportsImages = config.api.getModel().info.supportsImages ?? false
			return await extractFileContent(path, supportsImages)
		},
		getFileInfo: async (path) => {
			try {
				const stats = await fs.stat(path)
				return { size: stats.size, isFile: stats.isFile(), exists: true }
			} catch {
				return { size: 0, isFile: false, exists: false }
			}
		},
		listFiles: async (path, recursive, limit) => await listFiles(path, recursive, limit),
		writeFile: async (path, content) => await fs.writeFile(path, content, "utf8"),
		saveOpenDocumentIfDirty: async (options) => {
			await HostProvider.workspace.saveOpenDocumentIfDirty(options)
		},
	}
}
