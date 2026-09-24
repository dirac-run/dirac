import type { DiracMessage } from "@shared/ExtensionMessage"
import pWaitFor from "p-wait-for"
import type { Controller } from "@/core/controller"
import { getSavedDiracMessages } from "@/core/storage/disk"
import { Logger } from "@/shared/services/Logger.js"
import { getLatestTaskIdForSession } from "../acp/acp-session-tasks.js"
import type { DiracAcpSession } from "./public-types.js"

export type WorkspaceCheckpoint = {
	id: string
	createdAt: string
	messageId: string
	commitHash: string
}

function workspaceCheckpointsFromMessages(messages: DiracMessage[]): WorkspaceCheckpoint[] {
	return messages
		.filter((message) => message.lastCheckpointHash)
		.map((message) => ({
			id: message.id,
			createdAt: new Date(message.ts).toISOString(),
			messageId: message.id,
			commitHash: message.lastCheckpointHash!,
		}))
		.reverse()
}

interface SessionCheckpointDeps {
	sessions: Map<string, DiracAcpSession>
	getController(session: DiracAcpSession): Controller | undefined
	emitSessionInfoUpdate(session: DiracAcpSession): Promise<void>
}

/**
 * Owns workspace-checkpoint surfaces for ACP sessions: listing snapshots from
 * task history and restoring task history plus workspace files to a checkpoint.
 */
export class SessionCheckpointService {
	constructor(private readonly deps: SessionCheckpointDeps) {}

	/** List the workspace snapshots created at task and tool boundaries for a session. */
	async listWorkspaceCheckpoints(sessionId: string): Promise<WorkspaceCheckpoint[]> {
		const session = this.deps.sessions.get(sessionId)
		if (!session) {
			throw new Error(`Session not found: ${sessionId}`)
		}

		const controller = this.deps.getController(session)
		if (!controller) {
			throw new Error(`Controller not found for session: ${sessionId}`)
		}

		const task = controller.task
		if (task) {
			return workspaceCheckpointsFromMessages(task.messageStateHandler.getDiracMessages())
		}

		const taskId = session.loadedTaskId ?? getLatestTaskIdForSession(sessionId) ?? sessionId
		await controller.getTaskWithId(taskId)
		const messages = await getSavedDiracMessages(taskId)
		return workspaceCheckpointsFromMessages(messages)
	}

	/** Restore both task history and workspace files to one previously listed checkpoint. */
	async restoreWorkspaceCheckpoint(sessionId: string, checkpointId: string): Promise<void> {
		await this.checkpointRestore(sessionId, checkpointId, "taskAndWorkspace")

		const session = this.deps.sessions.get(sessionId)
		if (session) {
			session.lastActivityAt = Date.now()
			await this.deps.emitSessionInfoUpdate(session)
		}
	}

	/**
	 * Restore a checkpoint in a session.
	 *
	 * Cancels any active task, finds the message matching the checkpoint
	 * ID (DiracMessage.id / toolCallId), and delegates to the controller's
	 */
	async checkpointRestore(sessionId: string, checkpointId: string, restoreType: string, offset?: number): Promise<void> {
		const session = this.deps.sessions.get(sessionId)
		if (!session) {
			throw new Error(`Session not found: ${sessionId}`)
		}

		const controller = this.deps.getController(session)
		if (!controller) {
			throw new Error(`Controller not found for session: ${sessionId}`)
		}

		// Cancel active task — cannot alter message history while task is running
		await controller.cancelTask()

		// Wait for the task to be fully re-initialized after cancellation.
		// cancelTask() re-initializes the task asynchronously, and we must
		// wait for it to be ready before accessing its message handler.
		await pWaitFor(() => controller.task?.taskState.isInitialized === true, {
			timeout: 3_000,
		}).catch((error) => {
			Logger.error("[DiracAgent.checkpointRestore] Failed to wait for task initialization:", error)
			throw error
		})

		// Find the message matching the checkpoint ID (DiracMessage.id / toolCallId)
		const message = controller.task?.messageStateHandler.getMessageById(checkpointId)

		if (message && controller.task?.checkpointManager) {
			await controller.task.checkpointManager.restoreCheckpoint(message.id, restoreType as any, offset)
		} else {
			throw new Error(`Checkpoint not found for id: ${checkpointId}`)
		}
	}
}
