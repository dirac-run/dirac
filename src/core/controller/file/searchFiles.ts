import { FileSearchRequest, FileSearchResults } from "@shared/proto/dirac/file"
import { convertSearchResultsToProtoFileInfos } from "@shared/proto-conversions/file/search-result-conversion"
import { Controller } from ".."
import { captureResultTelemetry, handleSearchError, mapSelectedType, prioritizeActiveFile, runSearch } from "./searchFilesHelpers"

/** Searches for files in the workspace with fuzzy matching. */
export async function searchFiles(controller: Controller, request: FileSearchRequest): Promise<FileSearchResults> {
	try {
		const results = await runSearch(controller, request, mapSelectedType(request.selectedType))
		if (!results) return { results: [], mentionsRequestId: request.mentionsRequestId }
		const prioritized = await prioritizeActiveFile(request, results)
		const protoResults = convertSearchResultsToProtoFileInfos(prioritized)
		await captureResultTelemetry(request, protoResults.length)
		return { results: protoResults, mentionsRequestId: request.mentionsRequestId }
	} catch (error) {
		return handleSearchError(request, error)
	}
}
