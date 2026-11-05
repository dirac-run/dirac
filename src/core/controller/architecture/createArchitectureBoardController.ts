import type { DiracMessage } from "@shared/ExtensionMessage"
import { ArchitectureBoardController } from "./ArchitectureBoardController"
import { architectureFeedbackInput } from "./architectureFeedbackInput"

type FeedbackSelection = ReturnType<Parameters<typeof architectureFeedbackInput>[1]>

interface ArchitectureBoardOwner {
	selected(): FeedbackSelection & {
		task?: NonNullable<FeedbackSelection["task"]> & {
			cwd: string
			workspaceManager?: { getRoots(): readonly { name?: string; path: string }[] }
		}
	}
	history(): readonly { id: string; cwdOnTaskInitialization?: string; workspaceRootPath?: string }[]
	directory(taskId: string): string
	readConversation(taskId: string): Promise<readonly DiracMessage[]>
}

/** Loaded only by a viewer-capable host on its first architecture request. */
export function createArchitectureBoardController(owner: ArchitectureBoardOwner): ArchitectureBoardController {
	return new ArchitectureBoardController(
		(taskId) => {
			const active = owner.selected().task
			if (active?.taskId === taskId) {
				if (active.executionProfile === "tasklet") {
					throw new Error("Architecture boards are unavailable to private tasklets")
				}
				return
			}
			if (!owner.history().some((item) => item.id === taskId)) {
				throw new Error("Architecture board owner is missing, deleted, or not a foreground conversation")
			}
		},
		owner.directory,
		(taskId) => {
			const active = owner.selected().task
			if (active?.taskId === taskId)
				return {
					cwd: active.cwd,
					roots: active.workspaceManager?.getRoots().map(({ name, path }) => ({ name, path })) ?? [],
				}
			const item = owner.history().find((item) => item.id === taskId)
			const cwd = item?.cwdOnTaskInitialization ?? item?.workspaceRootPath
			return cwd ? { cwd, roots: [] } : undefined
		},
		{
			input: (taskId) => architectureFeedbackInput(taskId, owner.selected),
			read: owner.readConversation,
		},
	)
}
