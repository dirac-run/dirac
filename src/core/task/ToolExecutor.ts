import { ApiHandler } from "@core/api"
import { FileContextTracker } from "@core/context/context-tracking/FileContextTracker"
import { formatResponse } from "@core/formatResponse"
import { getHooksEnabledSafe } from "@core/hooks/hooks-utils"
import { DiracIgnoreController } from "@core/ignore/DiracIgnoreController"
import { CommandPermissionController } from "@core/permissions"
import type { SystemPromptContext } from "@core/prompts/system-prompt/types"
import { DiffViewProvider } from "@integrations/editor/DiffViewProvider"
import type { CommandExecutionOptions } from "@integrations/terminal"
import { BrowserSession } from "@services/browser/BrowserSession"
import { UrlContentFetcher } from "@services/browser/UrlContentFetcher"
import { CardStatus, DiracMessage } from "@shared/ExtensionMessage"
import { DiracContent } from "@shared/messages/content"
import { DiracDefaultTool, type DiracToolSpec } from "@shared/tools"
import { isParallelToolCallingEnabled, modelDoesntSupportWebp } from "@/utils/model-utils"
import { ToolUse } from "../assistant-message"
import { ContextManager } from "../context/context-management/ContextManager"
import { StateManager } from "../storage/StateManager"
import { WorkspaceRootManager } from "../workspace"
import { MessageStateHandler } from "./message-state"
import { TaskState } from "./TaskState"
import { AutoApprove } from "./tools/autoApprove"
import { IDiracContext } from "./tools/interfaces/IDiracContext"
import { ToolErrorHandler, ToolHookRunner } from "./tools/runtime/ToolHookRunner"
import { ToolResultPusher } from "./tools/runtime/ToolResultPusher"
import type { ToolRequestSnapshot, ToolSnapshotDirtyReason } from "./tools/runtime/ToolSnapshot"
import { ToolSnapshotManager } from "./tools/runtime/ToolSnapshotManager"
import { ToolExecutorCoordinator } from "./tools/ToolExecutorCoordinator"
import { TaskConfig, validateTaskConfig } from "./tools/types/TaskConfig"
import { ToolDisplayUtils } from "./tools/utils/ToolDisplayUtils"

export function canonicalizeAttemptCompletionParams(block: ToolUse): boolean {
	if (block.name === DiracDefaultTool.ATTEMPT && !block.params?.result && typeof block.params?.response === "string") {
		block.params.result = block.params.response
		return true
	}
	return false
}

// Main tool execution entry point — dispatches tool calls, manages hooks, errors, and results.
export class ToolExecutor {
	private autoApprover: AutoApprove
	private coordinator: ToolExecutorCoordinator
	private snapshotManager: ToolSnapshotManager
	private hookRunner: ToolHookRunner
	private resultPusher: ToolResultPusher
	private errorHandler: ToolErrorHandler

	private static readonly PLAN_MODE_RESTRICTED_TOOLS: DiracDefaultTool[] = [
		DiracDefaultTool.FILE_NEW,
		DiracDefaultTool.EDIT_FILE,
	]

	constructor(
		private taskState: TaskState,
		private messageStateHandler: MessageStateHandler,
		private api: ApiHandler,
		private urlContentFetcher: UrlContentFetcher,
		private browserSession: BrowserSession,
		private diffViewProvider: DiffViewProvider,
		private fileContextTracker: FileContextTracker,
		private diracIgnoreController: DiracIgnoreController,
		private commandPermissionController: CommandPermissionController,
		private contextManager: ContextManager,
		private taskMessenger: import("./TaskMessenger").TaskMessenger,
		private stateManager: StateManager,
		private cwd: string,
		private taskId: string,
		private ulid: string,
		private terminalExecutionMode: "vscodeTerminal" | "backgroundExec",
		private workspaceManager: WorkspaceRootManager | undefined,
		private isMultiRootEnabled: boolean,
		private saveCheckpoint: (isAttemptCompletionMessage?: boolean, completionMessageId?: string) => Promise<void>,
		private executeCommandTool: (
			command: string,
			timeoutSeconds: number | undefined,
			options?: CommandExecutionOptions,
		) => Promise<import("@integrations/terminal").CommandExecutionResult>,
		private cancelRunningCommandTool: () => Promise<boolean>,
		private doesLatestTaskCompletionHaveNewChanges: () => Promise<boolean>,
		private switchToActMode: () => Promise<boolean>,
		private cancelTask: () => Promise<void>,
		private postStateToWebview: () => Promise<void>,
		private setActiveHookExecution: (hookExecution: NonNullable<typeof taskState.activeHookExecution>) => Promise<void>,
		private clearActiveHookExecution: () => Promise<void>,
		private getActiveHookExecution: () => Promise<typeof taskState.activeHookExecution>,
		private runUserPromptSubmitHook: (
			userContent: DiracContent[],
			context: "initial_task" | "resume" | "feedback",
		) => Promise<{ cancel?: boolean; wasCancelled?: boolean; contextModification?: string; errorMessage?: string }>,
		private diracContext: IDiracContext,
		private resetTransientState: () => Promise<void>,
	) {
		this.autoApprover = new AutoApprove(this.stateManager, this.commandPermissionController)
		this.coordinator = new ToolExecutorCoordinator()
		this.snapshotManager = new ToolSnapshotManager({
			createTaskConfig: (coordinator) => this.asToolConfig(coordinator),
			getWorkspaceRoot: () => this.workspaceManager?.getPrimaryRoot()?.path,
			getToggles: () => this.stateManager.getGlobalSettingsKey("toolToggles") || {},
			getActiveSkills: () => {
				const activeIds = new Set(this.taskState.activeSkillIds)
				return this.taskState.availableSkills.filter((skill) => activeIds.has(skill.name))
			},
		})
		this.hookRunner = new ToolHookRunner(
			taskState,
			messageStateHandler,
			api,
			stateManager,
			taskMessenger,
			taskId,
			setActiveHookExecution,
			clearActiveHookExecution,
		)
		this.resultPusher = new ToolResultPusher(taskState)
		this.errorHandler = new ToolErrorHandler(taskState, taskMessenger)
	}

	private shouldAutoApproveTool(toolName: DiracDefaultTool): boolean | [boolean, boolean] {
		return this.autoApprover.shouldAutoApproveTool(toolName)
	}

	private async shouldAutoApproveToolWithPath(
		blockname: DiracToolSpec["id"],
		autoApproveActionpath: string | undefined,
	): Promise<boolean> {
		if (!Object.values(DiracDefaultTool).includes(blockname as DiracDefaultTool)) return false
		return this.autoApprover.shouldAutoApproveToolWithPath(blockname as DiracDefaultTool, autoApproveActionpath)
	}

	private asToolConfig(coordinator = this.coordinator): TaskConfig {
		const config: TaskConfig = {
			taskId: this.taskId,
			ulid: this.ulid,
			mode: this.stateManager.getGlobalSettingsKey("mode"),
			strictPlanModeEnabled: this.stateManager.getGlobalSettingsKey("strictPlanModeEnabled"),
			yoloModeToggled: this.stateManager.getGlobalSettingsKey("yoloModeToggled"),
			doubleCheckCompletionEnabled: this.stateManager.getGlobalSettingsKey("doubleCheckCompletionEnabled"),
			vscodeTerminalExecutionMode: this.terminalExecutionMode,
			enableParallelToolCalling: this.isParallelToolCallingEnabled(),
			isSubagentExecution: false,
			backgroundEditEnabled: !!this.stateManager.getGlobalSettingsKey("backgroundEditEnabled"),
			context: this.diracContext,
			cwd: this.cwd,
			workspaceManager: this.workspaceManager,
			isMultiRootEnabled: this.isMultiRootEnabled,
			taskState: this.taskState,
			messageState: this.messageStateHandler,
			api: this.api,
			autoApprovalSettings: this.stateManager.getGlobalSettingsKey("autoApprovalSettings"),
			autoApprover: this.autoApprover,
			browserSettings: this.stateManager.getGlobalSettingsKey("browserSettings"),
			services: {
				browserSession: this.browserSession,
				urlContentFetcher: this.urlContentFetcher,
				diffViewProvider: this.diffViewProvider,
				fileContextTracker: this.fileContextTracker,
				diracIgnoreController: this.diracIgnoreController,
				commandPermissionController: this.commandPermissionController,
				contextManager: this.contextManager,
				stateManager: this.stateManager,
			},
			callbacks: {
				saveCheckpoint: async (isAttemptCompletionMessage?: boolean, completionMessageId?: string) => {
					await this.saveCheckpoint(isAttemptCompletionMessage, completionMessageId)
				},
				postStateToWebview: this.postStateToWebview.bind(this),
				cancelTask: this.cancelTask,
				executeCommandTool: this.executeCommandTool,
				cancelRunningCommandTool: this.cancelRunningCommandTool,
				doesLatestTaskCompletionHaveNewChanges: this.doesLatestTaskCompletionHaveNewChanges,
				getDiracMessages: () => this.messageStateHandler.getDiracMessages(),
				updateDiracMessage: async (index: number, updates: Partial<DiracMessage>) => {
					await this.messageStateHandler.updateDiracMessage(index, updates)
					await config.callbacks.postStateToWebview()
				},
				shouldAutoApproveTool: this.shouldAutoApproveTool.bind(this),
				shouldAutoApproveToolWithPath: this.shouldAutoApproveToolWithPath.bind(this),
				applyLatestBrowserSettings: this.applyLatestBrowserSettings.bind(this),
				switchToActMode: this.switchToActMode,
				setActiveHookExecution: this.setActiveHookExecution,
				clearActiveHookExecution: this.clearActiveHookExecution,
				getActiveHookExecution: this.getActiveHookExecution,
				runUserPromptSubmitHook: this.runUserPromptSubmitHook,
				resetTransientState: this.resetTransientState,
			},
			coordinator,
			taskMessenger: this.taskMessenger,
		}
		config.activeToolSnapshot = this.snapshotManager?.getActiveSnapshot()
		validateTaskConfig(config)
		return config
	}

	public async refreshToolsForTask(): Promise<void> {
		this.markToolsDirty("task_start")
	}
	public markToolsDirty(reason: ToolSnapshotDirtyReason): void {
		this.snapshotManager.markDirty(reason)
	}
	public async getSnapshotForRequest(context: SystemPromptContext): Promise<ToolRequestSnapshot> {
		return this.snapshotManager.getSnapshotForRequest(context)
	}
	public getActiveSnapshot(): ToolRequestSnapshot | undefined {
		return this.snapshotManager.getActiveSnapshot()
	}
	public activateSnapshot(snapshot: ToolRequestSnapshot): void {
		this.snapshotManager.activateSnapshot(snapshot)
		this.coordinator = snapshot.coordinator
	}
	public async executeTool(block: ToolUse, isComplete = true): Promise<void> {
		await this.execute(block, isComplete)
	}

	public async applyLatestBrowserSettings() {
		await this.browserSession.dispose()
		const useWebp = this.api ? !modelDoesntSupportWebp(this.api.getModel()) : true
		this.browserSession = new BrowserSession(this.stateManager, useWebp)
		return this.browserSession
	}

	private isParallelToolCallingEnabled(): boolean {
		const enableParallelSetting = this.stateManager.getGlobalSettingsKey("enableParallelToolCalling")
		const model = this.api.getModel()
		const apiConfig = this.stateManager.getApiConfiguration()
		const mode = this.stateManager.getGlobalSettingsKey("mode")
		const providerId = (mode === "plan" ? apiConfig.planModeApiProvider : apiConfig.actModeApiProvider) as string
		return isParallelToolCallingEnabled(enableParallelSetting, { providerId, model, mode })
	}

	private isPlanModeToolRestricted(toolName: DiracDefaultTool): boolean {
		return ToolExecutor.PLAN_MODE_RESTRICTED_TOOLS.includes(toolName)
	}

	private createToolRejectionMessage(block: ToolUse, reason: string): void {
		this.taskState.userMessageContent.push({
			type: "text",
			text: `${reason} ${ToolDisplayUtils.getToolDescription(block, this.coordinator)}`,
		})
	}

	private async execute(block: ToolUse, isComplete = true): Promise<boolean> {
		if (!this.coordinator.has(block.name)) return false
		canonicalizeAttemptCompletionParams(block)
		const config = this.asToolConfig()
		try {
			if (this.taskState.didRejectTool) {
				const reason = !isComplete
					? "Tool was interrupted and not executed due to user rejecting a previous tool."
					: "Skipping tool due to user rejecting a previous tool."
				this.createToolRejectionMessage(block, reason)
				return true
			}
			if (await this.isPlanModeRestricted(block, isComplete)) return true
			if (block.name !== "browser_action") await this.browserSession.closeBrowser()
			if (!isComplete) {
				await this.coordinator.bufferPartialToolUse(block, config)
				return true
			}
			await this.handleCompleteBlock(block, config)
			return true
		} catch (error) {
			await this.errorHandler.handleError(
				`executing ${block.name}`,
				error as Error,
				block,
				this.resultPusher.pushToolResult.bind(this.resultPusher),
			)
			return true
		}
	}

	// Checks plan mode restrictions and creates error card if tool is restricted.
	private async isPlanModeRestricted(block: ToolUse, isComplete = true): Promise<boolean> {
		if (
			!this.stateManager.getGlobalSettingsKey("strictPlanModeEnabled") ||
			this.stateManager.getGlobalSettingsKey("mode") !== "plan" ||
			!block.name ||
			!this.isPlanModeToolRestricted(block.name as DiracDefaultTool)
		)
			return false
		const errorMessage = `Tool '${block.name}' is not available in PLAN MODE. This tool is restricted to ACT MODE for file modifications. Only use tools available for PLAN MODE when in that mode.`
		await this.taskMessenger.createCard({ header: "Plan Mode Restriction", body: errorMessage, status: CardStatus.ERROR })
		if (isComplete) await this.resultPusher.pushToolResult(formatResponse.toolError(errorMessage), block)
		return true
	}

	private async handleCompleteBlock(block: ToolUse, config: any): Promise<void> {
		if (this.taskState.abort) return
		const hooksEnabled = getHooksEnabledSafe(this.stateManager.getGlobalSettingsKey("hooksEnabled"))
		let shouldCancelAfterHook = false
		let executionSuccess = true
		let toolResult: any = null
		let toolWasExecuted = false
		const executionStartTime = Date.now()
		try {
			if (this.taskState.abort) return
			toolResult = await this.coordinator.execute(config, block)
			toolWasExecuted = true
			const count = ++this.taskState.totalToolCallCount
			toolResult = ToolResultPusher.appendLoopWarning(toolResult, count)
			if (!this.taskState.didAttemptCompletion) await this.resultPusher.pushToolResult(toolResult, block)
			if (this.taskState.abort) return
			if (hooksEnabled && block.name !== "attempt_completion") {
				if (
					await this.hookRunner.runPostToolUseHook(
						block,
						toolResult,
						executionSuccess,
						executionStartTime,
						hooksEnabled,
					)
				) {
					await config.callbacks.cancelTask()
					shouldCancelAfterHook = true
				}
			}
		} catch (error) {
			executionSuccess = false
			toolResult = formatResponse.toolError(`Tool execution failed: ${error}`)
			if (this.taskState.abort) throw error
			if (toolWasExecuted && hooksEnabled && block.name !== "attempt_completion") {
				if (
					await this.hookRunner.runPostToolUseHook(
						block,
						toolResult,
						executionSuccess,
						executionStartTime,
						hooksEnabled,
					)
				) {
					await config.callbacks.cancelTask()
					shouldCancelAfterHook = true
				}
			}
			throw error
		}
		if (shouldCancelAfterHook) return
	}
}
