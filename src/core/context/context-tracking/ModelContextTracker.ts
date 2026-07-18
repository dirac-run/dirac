import { updateTaskMetadata } from "@core/storage/disk"

export class ModelContextTracker {
	readonly taskId: string

	constructor(taskId: string) {
		this.taskId = taskId
	}

	async recordModelUsage(apiProviderId: string, modelId: string, mode: string) {
		await updateTaskMetadata(this.taskId, (metadata) => {
			metadata.model_usage ??= []

			const lastEntry = metadata.model_usage[metadata.model_usage.length - 1]
			if (
				lastEntry &&
				lastEntry.model_id === modelId &&
				lastEntry.model_provider_id === apiProviderId &&
				lastEntry.mode === mode
			) {
				return
			}

			metadata.model_usage.push({
				ts: Date.now(),
				model_id: modelId,
				model_provider_id: apiProviderId,
				mode,
			})
		})
	}
}
