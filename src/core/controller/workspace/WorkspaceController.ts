import { detectWorkspaceRoots } from "@core/workspace/detection"
import { setupWorkspaceManager } from "@core/workspace/setup"
import { WorkspaceRootManager } from "@core/workspace/WorkspaceRootManager"
import { Logger } from "@/shared/services/Logger"
import type { StateManager } from "../../storage/StateManager"

type SetupWorkspaceManagerFn = typeof setupWorkspaceManager
type DetectRootsFn = typeof detectWorkspaceRoots

export class WorkspaceController {
	private workspaceManager?: WorkspaceRootManager

	constructor(
		private readonly stateManager: StateManager,
		private readonly workspaceCwd?: string,
		private readonly setupWorkspaceManagerFn: SetupWorkspaceManagerFn = setupWorkspaceManager,
		private readonly detectRootsFn: DetectRootsFn = detectWorkspaceRoots,
	) {}

	async ensureWorkspaceManager(): Promise<WorkspaceRootManager | undefined> {
		if (!this.workspaceManager) {
			try {
				this.workspaceManager = this.workspaceCwd
					? await WorkspaceRootManager.fromLegacyCwd(this.workspaceCwd)
					: await this.setupWorkspaceManagerFn({
							stateManager: this.stateManager,
							detectRoots: this.detectRootsFn,
						})
			} catch (error) {
				Logger.error("[Controller] Failed to initialize workspace manager:", error)
			}
		}
		return this.workspaceManager
	}

	getWorkspaceManager(): WorkspaceRootManager | undefined {
		return this.workspaceManager
	}
}
