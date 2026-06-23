import { workspaceResolver } from "@core/workspace"
import { searchWorkspaceFiles, searchWorkspaceFilesMultiroot } from "@services/search/file-search"
import { telemetryService } from "@services/telemetry"
import { FileSearchRequest, FileSearchResults, FileSearchType } from "@shared/proto/dirac/file"
import { getWorkspacePath } from "@utils/path"
import * as path from "path"
import { HostProvider } from "@/hosts/host-provider"
import { Logger } from "@/shared/services/Logger"
import { Controller } from ".."

export type SearchResult = { path: string; type: "file" | "folder"; label?: string; workspaceName?: string }
// Maps the proto FileSearchType enum to the string filter used by the search service
export const mapSelectedType = (t?: FileSearchType): "file" | "folder" | undefined =>
	t === FileSearchType.FILE ? "file" : t === FileSearchType.FOLDER ? "folder" : undefined
// Runs search via multiroot manager or single workspace; returns null when no workspace path is available
export async function runSearch(
	controller: Controller,
	request: FileSearchRequest,
	selectedType: "file" | "folder" | undefined,
): Promise<SearchResult[] | null> {
	const wm = await controller.ensureWorkspaceManager()
	if (wm && wm.getRoots()?.length > 0)
		return searchWorkspaceFilesMultiroot(request.query || "", wm, request.limit || 20, selectedType, request.workspaceHint)
	const workspacePath = await getWorkspacePath()
	if (!workspacePath) {
		Logger.error("Error in searchFiles: No workspace path available")
		telemetryService.captureMentionFailed("folder", "not_found", "No workspace path available")
		return null
	}
	return searchWorkspaceFiles(request.query || "", workspacePath, request.limit || 20, selectedType)
}
// Resolves an absolute path to a workspace-relative POSIX-style path
function toRelativePath(workspacePath: string, absolutePath: string): string {
	const ws = workspaceResolver.resolveWorkspacePath(workspacePath, "", "searchFiles.prioritize")
	const active = workspaceResolver.resolveWorkspacePath(absolutePath, "", "searchFiles.prioritize")
	const wsAbs = typeof ws === "string" ? ws : ws.absolutePath
	const activeAbs = typeof active === "string" ? active : active.absolutePath
	let relative = path.relative(wsAbs, activeAbs)
	if (path.sep === "\\") relative = relative.replace(/\\/g, "/")
	return relative
}
// Moves the active editor file to position 0 when prioritizeActiveFile is set
export async function prioritizeActiveFile(request: FileSearchRequest, results: SearchResult[]): Promise<SearchResult[]> {
	if (!request.prioritizeActiveFile || results.length === 0) return results
	try {
		const activeFilePath = (await HostProvider.window.getActiveEditor({})).filePath
		const workspacePath = await getWorkspacePath()
		if (activeFilePath && workspacePath) {
			const rel = toRelativePath(workspacePath, activeFilePath)
			const idx = results.findIndex((r) => r.path === rel || r.path === `/${rel}`)
			if (idx > 0) {
				const [item] = results.splice(idx, 1)
				results.unshift(item)
			}
		}
	} catch (err) {
		Logger.error("Error prioritizing active file:", err)
	}
	return results
}
// Captures telemetry describing the search outcome
export const captureResultTelemetry = (request: FileSearchRequest, count: number) =>
	telemetryService.captureMentionSearchResults(
		request.query || "",
		count,
		mapSelectedType(request.selectedType) ?? "all",
		count === 0,
	)
// Logs error and captures failure telemetry, returning an empty result set
export async function handleSearchError(request: FileSearchRequest, error: unknown): Promise<FileSearchResults> {
	Logger.error("Error in searchFiles:", error)
	const msg = error instanceof Error ? error.message : String(error)
	const type = error instanceof Error && error.message.includes("permission") ? "permission_denied" : "unknown"
	await telemetryService.captureMentionFailed(request.selectedType === FileSearchType.FILE ? "file" : "folder", type, msg)
	return { results: [], mentionsRequestId: request.mentionsRequestId }
}
