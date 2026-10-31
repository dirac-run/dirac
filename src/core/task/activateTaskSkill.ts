import { updateTaskMetadata } from "@core/storage/disk"
import type { TaskStorageAddress } from "@core/storage/taskDirectory"
import type { TaskState } from "./TaskState"

export async function activateTaskSkill(
	address: string | TaskStorageAddress,
	taskState: TaskState,
	skillId: string,
): Promise<void> {
	const metadata = await updateTaskMetadata(address, (current) => {
		current.active_skill_ids = [...new Set([...(current.active_skill_ids ?? []), skillId])]
	})
	taskState.activeSkillIds = metadata.active_skill_ids ?? []
}
