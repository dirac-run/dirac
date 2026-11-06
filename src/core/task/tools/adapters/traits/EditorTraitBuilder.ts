import type { IEditorTrait } from "../../interfaces/IToolEnvironment"
import type { TaskConfig } from "../../types/TaskConfig"

export function buildEditorTrait(config: TaskConfig): IEditorTrait {
	const diffView = () => config.services.diffViewProvider
	const withMutationAuthorization = <T>(mutation: () => Promise<T>) =>
		config.callbacks.withMutationAuthorization(config.toolUse?.name, mutation)
	const mapSaveResult = (result: any) => ({
		content: result.finalContent ?? "",
		userEdits: !!result.userEdits,
		autoFormatting: !!result.autoFormattingEdits,
	})
	return {
		readText: async (path) => await diffView().readText(path),
		showReview: async (files, card) =>
			await diffView().showReview(
				files,
				config.taskMessenger.routesToOwner || card.requiresUserInteraction === false
					? undefined
					: { taskId: config.taskId, cardId: card.id },
			),
		hideReview: async () => await diffView().hideReview(),
		open: async (path, options) => await withMutationAuthorization(() => diffView().open(path, options)),
		update: async (content, finalize) =>
			await withMutationAuthorization(() => diffView().update(content, finalize)),
		saveChanges: async (options) =>
			mapSaveResult(await withMutationAuthorization(() => diffView().saveChanges(options))),
		applyAndSaveSilently: async (path, content, editType) =>
			mapSaveResult(
				await withMutationAuthorization(() => diffView().applyAndSaveSilently(path, content, editType)),
			),
		applyAndSaveBatchSilently: async (files) => {
			const results = await withMutationAuthorization(() => diffView().applyAndSaveBatchSilently(files))
			const mapped = new Map<string, any>()
			for (const [path, result] of results.entries()) mapped.set(path, mapSaveResult(result))
			return mapped
		},
		revertChanges: async () => await withMutationAuthorization(() => diffView().revertChanges()),
		reset: async () => await diffView().reset(),
		scrollToFirstDiff: async () => await diffView().scrollToFirstDiff(),
		undoUserEdits: async () => await withMutationAuthorization(() => diffView().undoUserEdits()),
		format: async (path) => await withMutationAuthorization(() => diffView().format(path)),
	}
}
