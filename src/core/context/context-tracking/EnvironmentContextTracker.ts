import { collectEnvironmentMetadata, updateTaskMetadata } from "@core/storage/disk"
import type { EnvironmentMetadataEntry } from "./ContextTrackerTypes"

export class EnvironmentContextTracker {
	readonly taskId: string

	constructor(taskId: string) {
		this.taskId = taskId
	}

	async recordEnvironment() {
		const currentEnv = await collectEnvironmentMetadata()
		const currentEnvWithTs: EnvironmentMetadataEntry = {
			ts: Date.now(),
			...currentEnv,
		}

		await updateTaskMetadata(this.taskId, (metadata) => {
			metadata.environment_history ??= []
			const lastEntry = metadata.environment_history[metadata.environment_history.length - 1]
			if (lastEntry && this.isSameEnvironment(lastEntry, currentEnvWithTs)) return
			metadata.environment_history.push(currentEnvWithTs)
		})
	}

	private isSameEnvironment(a: EnvironmentMetadataEntry, b: EnvironmentMetadataEntry): boolean {
		return (
			a.os_name === b.os_name &&
			a.os_version === b.os_version &&
			a.os_arch === b.os_arch &&
			a.host_name === b.host_name &&
			a.host_version === b.host_version &&
			a.dirac_version === b.dirac_version
		)
	}
}
