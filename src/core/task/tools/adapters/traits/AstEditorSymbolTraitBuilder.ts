import { ASTAnchorBridge } from "@utils/ASTAnchorBridge"
import { HostProvider } from "@/hosts/host-provider"
import { SymbolIndexService } from "@/services/symbol-index/SymbolIndexService"
import type { IASTTrait, IDiagnosticsTrait, IEditorTrait, ISymbolTrait } from "../../interfaces/IToolEnvironment"
import type { TaskConfig } from "../../types/TaskConfig"

// Builds the AST trait — file skeleton and function extraction via ASTAnchorBridge.
export function buildAstTrait(config: TaskConfig): IASTTrait {
	return {
		getSkeleton: async (path, options) => {
			const skeleton = await ASTAnchorBridge.getFileSkeleton(
				path,
				config.services.diracIgnoreController,
				config.ulid,
				options || { showCallGraph: true },
			)
			return skeleton || ""
		},
		getFunctions: async (absolutePath, relPath, functionNames, includeAnchors) => {
			return await ASTAnchorBridge.getFunctions(
				absolutePath,
				relPath,
				functionNames,
				config.services.diracIgnoreController,
				config.ulid,
				includeAnchors,
			)
		},
	}
}

// Builds the diagnostics trait — prepare and retrieve via HostProvider.
export function buildDiagnosticsTrait(): IDiagnosticsTrait {
	return {
		prepare: async (paths) => {
			await HostProvider.workspace.prepareDiagnostics({ filePaths: paths })
		},
		getRaw: async (paths) => {
			const response = await HostProvider.workspace.getDiagnostics({ filePaths: paths })
			return response.fileDiagnostics || []
		},
	}
}

// Builds the editor trait — diff view operations via DiffViewProvider.
export function buildEditorTrait(config: TaskConfig): IEditorTrait {
	const dv = () => config.services.diffViewProvider
	const mapSaveResult = (r: any) => ({
		content: r.finalContent || "",
		userEdits: !!r.userEdits,
		autoFormatting: !!r.autoFormattingEdits,
	})
	return {
		showReview: async (files) => await dv().showReview(files),
		hideReview: async () => await dv().hideReview(),
		open: async (path, options) => await dv().open(path, options),
		update: async (content, finalize) => await dv().update(content, finalize),
		saveChanges: async (options) => mapSaveResult(await dv().saveChanges(options)),
		applyAndSaveSilently: async (path, content) => mapSaveResult(await dv().applyAndSaveSilently(path, content)),
		applyAndSaveBatchSilently: async (files) => {
			const results = await dv().applyAndSaveBatchSilently(files)
			const mapped = new Map<string, any>()
			for (const [path, r] of results.entries()) mapped.set(path, mapSaveResult(r))
			return mapped
		},
		revertChanges: async () => await dv().revertChanges(),
		reset: async () => await dv().reset(),
		scrollToFirstDiff: async () => await dv().scrollToFirstDiff(),
		undoUserEdits: async () => await dv().undoUserEdits(),
		format: async (path) => await dv().format(path),
	}
}

// Builds the symbol trait — definitions, references, and index management via SymbolIndexService.
export function buildSymbolTrait(): ISymbolTrait {
	const svc = () => SymbolIndexService.getInstance()
	return {
		getSymbolRange: async (path, symbol, type) => (await ASTAnchorBridge.getSymbolRange(path, symbol, type)) || undefined,
		getDefinitions: async (symbol) => await svc().getDefinitions(symbol),
		getReferences: async (symbol) => await svc().getReferences(symbol),
		getSymbols: async (symbol) => await svc().getSymbols(symbol),
		updateIndex: async (path) => {
			await svc().updateFile(path)
		},
		initializeIndex: async (root) => {
			await svc().initialize(root)
		},
	}
}
