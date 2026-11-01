import { invalidateArchitectureTask } from "@core/architecture/architectureLifetime"
import fs from "fs/promises"
import path from "path"
import { HostProvider } from "@/hosts/host-provider"
import { isTaskletId, TASKLET_ID_PREFIX, type TaskStorageAddress } from "@/shared/taskletId"

export type { TaskStorageAddress } from "@/shared/taskletId"

function assertTaskDirectoryId(taskId: string): void {
	if (
		!taskId ||
		taskId === "." ||
		taskId === ".." ||
		taskId.includes("/") ||
		taskId.includes("\\") ||
		taskId.includes("\0") ||
		taskId.startsWith(TASKLET_ID_PREFIX)
	) {
		throw new Error(`Invalid task directory identity: ${JSON.stringify(taskId)}`)
	}
}

export function getTasksDirectoryPath(): string {
	return path.resolve(HostProvider.get().globalStorageFsPath, "tasks")
}

/** Bare strings retain ordinary Task addressing; tasklets always require their owning root. */
export function getTaskDirectoryPath(address: string | TaskStorageAddress): string {
	if (typeof address === "string") {
		assertTaskDirectoryId(address)
		return path.join(getTasksDirectoryPath(), address)
	}
	if (address.kind === "task") return getTaskDirectoryPath(address.taskId)

	const rootDirectory = getTaskDirectoryPath(address.rootTaskId)
	if (!isTaskletId(address.taskletId)) {
		throw new Error(`Invalid tasklet directory identity: ${JSON.stringify(address.taskletId)}`)
	}
	return path.join(rootDirectory, "tasklets", address.taskletId)
}

export async function listTaskDirectoryIds(): Promise<string[]> {
	try {
		const entries = await fs.readdir(getTasksDirectoryPath(), { withFileTypes: true })
		return entries
			.filter((entry) => entry.isDirectory() && !entry.name.endsWith(".lock") && !entry.name.startsWith(TASKLET_ID_PREFIX))
			.map((entry) => entry.name)
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return []
		throw error
	}
}

/** Deletes every persisted artifact owned by one Task-shaped run directory. */
export async function deleteTaskDirectory(taskId: string): Promise<void> {
	const taskDirectory = getTaskDirectoryPath(taskId)
	invalidateArchitectureTask(taskDirectory)
	await fs.rm(taskDirectory, { recursive: true, force: true })
}
