import { resolveWorkspacePath } from "@core/workspace"
import { SourceAstService } from "@services/source-ast/SourceAstService"
import { AnchorStateManager } from "@utils/AnchorStateManager"
import { getTaskScopedStateKey } from "@shared/taskletId"
import type { ISourceAstTrait } from "../../interfaces/IToolEnvironment"
import type { TaskConfig } from "../../types/TaskConfig"

export function buildSourceAstTrait(config: TaskConfig): ISourceAstTrait {
	const anchorStateKey = getTaskScopedStateKey(config.ulid, config.storageAddress)
	const reconcileAnchors = (absolutePath: string, lines: string[]): string[] => {
		const result = AnchorStateManager.reconcileWithChanges(absolutePath, lines, anchorStateKey)
		if (result.changed) config.context.markAnchorStateDirty(absolutePath)
		return result.anchors
	}
	const service = new SourceAstService({
		root: config.cwd,
		resolvePath: async (requestedPath) => {
			const resolved = resolveWorkspacePath(config, requestedPath, "SourceAstTraitBuilder.resolvePath")
			return typeof resolved === "string"
				? { absolutePath: resolved, displayPath: requestedPath }
				: { absolutePath: resolved.absolutePath, displayPath: resolved.displayPath }
		},
		validateAccess: (absolutePath) => config.services.diracIgnoreController.validateAccess(absolutePath),
		reconcileAnchors,
		getAnchorFingerprint: (absolutePath) => AnchorStateManager.getDocumentFingerprint(absolutePath, anchorStateKey),
	})

	return {
		outline: async (request) => {
			if (request.includeAnchors) await config.context.ensureAnchorState()
			return service.outline(request)
		},
		implementations: async (request) => {
			if (request.includeAnchors) await config.context.ensureAnchorState()
			return service.implementations(request)
		},
		occurrences: async (request) => {
			if (request.includeAnchors) await config.context.ensureAnchorState()
			return service.occurrences(request)
		},
		planRename: (request) => service.planRename(request),
		planReplacements: (request) => service.planReplacements(request),
		getAnchorFingerprint: (path) => service.getAnchorFingerprint(path),
	}
}
