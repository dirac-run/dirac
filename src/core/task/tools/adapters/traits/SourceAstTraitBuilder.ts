import { resolveWorkspacePath } from "@core/workspace"
import { SourceAstService } from "@services/source-ast/SourceAstService"
import { AnchorStateManager } from "@utils/AnchorStateManager"
import { getTaskScopedStateKey } from "@shared/taskletId"
import type { ISourceAstTrait } from "../../interfaces/IToolEnvironment"
import type { TaskConfig } from "../../types/TaskConfig"

export function buildSourceAstTrait(config: TaskConfig): ISourceAstTrait {
	const anchorStateKey = getTaskScopedStateKey(config.ulid, config.storageAddress)
	// Facades are query-scoped so late service callbacks cannot commit this tool's anchor context.
	// The symbol index and parser caches remain shared, service-owned resources.
	const createService = (signal?: AbortSignal) => new SourceAstService({
		root: config.cwd,
		resolvePath: async (requestedPath) => {
			signal?.throwIfAborted()
			const resolved = resolveWorkspacePath(config, requestedPath, "SourceAstTraitBuilder.resolvePath")
			return typeof resolved === "string"
				? { absolutePath: resolved, displayPath: requestedPath }
				: { absolutePath: resolved.absolutePath, displayPath: resolved.displayPath }
		},
		validateAccess: (absolutePath) => config.services.diracIgnoreController.validateAccess(absolutePath),
		reconcileAnchors: (absolutePath, lines) => {
			signal?.throwIfAborted()
			const result = AnchorStateManager.reconcileWithChanges(absolutePath, lines, anchorStateKey)
			if (result.changed) config.context.markAnchorStateDirty(absolutePath)
			return result.anchors
		},
		getAnchorFingerprint: (absolutePath) => AnchorStateManager.getDocumentFingerprint(absolutePath, anchorStateKey),
	})

	const service = createService()

	return {
		outline: async (request, signal) => {
			signal?.throwIfAborted()
			if (request.includeAnchors) await config.context.ensureAnchorState()
			signal?.throwIfAborted()
			return createService(signal).outline(request)
		},
		implementations: async (request, signal) => {
			signal?.throwIfAborted()
			if (request.includeAnchors) await config.context.ensureAnchorState()
			signal?.throwIfAborted()
			return createService(signal).implementations(request)
		},
		occurrences: async (request, signal) => {
			signal?.throwIfAborted()
			if (request.includeAnchors) await config.context.ensureAnchorState()
			signal?.throwIfAborted()
			return createService(signal).occurrences(request)
		},
		planRename: (request) => service.planRename(request),
		planReplacements: (request) => service.planReplacements(request),
		getAnchorFingerprint: (path) => service.getAnchorFingerprint(path),
	}
}
