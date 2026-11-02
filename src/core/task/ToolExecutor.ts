import { ApiHandler, buildApiHandler, buildApiHandlerForSelection } from "@core/api"
import { FileContextTracker } from "@core/context/context-tracking/FileContextTracker"
import { formatResponse } from "@core/formatResponse"
import { getHooksEnabledSafe } from "@core/hooks/hooks-utils"
import { DiracIgnoreController } from "@core/ignore/DiracIgnoreController"
import { CommandPermissionController } from "@core/permissions"
import {
	UtilityPermissionDecisionService,
	type PermissionDecisionServiceBinding,
} from "@core/permissions/UtilityPermissionDecisionService"
import type { SystemPromptContext } from "@core/prompts/system-prompt/types"
import { createUtilityModelRunner } from "@core/utility-model/UtilityModelRunner"
import { getConfiguredUtilityModelSelection } from "@core/utility-model/UtilityModelSelection"
import { DiffViewProvider } from "@integrations/editor/DiffViewProvider"
import type { CommandExecutionOptions } from "@integrations/terminal"
import { BrowserSession } from "@services/browser/BrowserSession"
import { UrlContentFetcher } from "@services/browser/UrlContentFetcher"
import type { ApiConfiguration, ApiProvider, ModelProviderSelection } from "@shared/api"
import { CardStatus, DiracMessage } from "@shared/ExtensionMessage"
import { Logger } from "@shared/services/Logger"
import { DiracContent } from "@shared/messages/content"
import { canonicalizeResponseToolCall, isCompletionResponseCall } from "@shared/responseTool"
import { getProviderModelIdKey } from "@shared/storage/provider-keys"
import { DiracDefaultTool, type DiracToolSpec } from "@shared/tools"
import type { TaskStorageAddress } from "@core/storage/taskDirectory"
import { modelDoesntSupportWebp } from "@/utils/model-utils"
import { ToolUse } from "../assistant-message"
import { ContextManager } from "../context/context-management/ContextManager"
import { StateManager } from "../storage/StateManager"
import { WorkspaceRootManager } from "../workspace"
import { MessageStateHandler } from "./message-state"
import { assertTaskMutationAuthorized, type TaskRequestRuntime } from "./runtime/TaskRequestRuntime"
import { deepFreezeConfiguration, type TaskWorkingConfiguration } from "./runtime/TaskWorkingConfiguration"
import { TaskState } from "./TaskState"
import { recordUtilityModelUsage } from "./recordUtilityModelUsage"
import { AutoApprove, type ToolPermissionDisposition } from "./tools/autoApprove"
import { IDiracContext } from "./tools/interfaces/IDiracContext"
import { ToolErrorHandler, ToolHookRunner } from "./tools/runtime/ToolHookRunner"
import { ToolResultPusher } from "./tools/runtime/ToolResultPusher"
import type { ToolRequestSnapshot, ToolSnapshotDirtyReason } from "./tools/runtime/ToolSnapshot"
import { ToolSnapshotManager } from "./tools/runtime/ToolSnapshotManager"
import { ToolExecutorCoordinator } from "./tools/ToolExecutorCoordinator"
import type { ToolEnvironmentFactory } from "./tools/interfaces/ToolEnvironmentFactory"
import { type SubagentRuntime, TaskConfig, validateTaskConfig } from "./tools/types/TaskConfig"
import { ToolDisplayUtils } from "./tools/utils/ToolDisplayUtils"
import type { TaskExecutionProfile } from "./TaskExecutionProfile"
import { isDiscoveredToolAvailableToTaskProfile } from "./TaskExecutionProfile"

export { canonicalizeResponseToolCall }

// Main tool execution entry point — dispatches tool calls, manages hooks, errors, and results.
export class ToolExecutor {
	private coordinator: ToolExecutorCoordinator
	private snapshotManager: ToolSnapshotManager
	private hookRunner: ToolHookRunner
	private resultPusher: ToolResultPusher
	private errorHandler: ToolErrorHandler
	private activeRequestRuntime?: TaskRequestRuntime
	private buildingRequestRuntime?: TaskRequestRuntime

	private static readonly PLAN_MODE_RESTRICTED_TOOLS: DiracDefaultTool[] = [
		DiracDefaultTool.FILE_NEW,
		DiracDefaultTool.EDIT_FILE,
		DiracDefaultTool.EDIT_AST,
	]

	constructor(
		private taskState: TaskState,
		private messageStateHandler: MessageStateHandler,
		private api: ApiHandler,
		private urlContentFetcher: UrlContentFetcher,
		private browserSession: BrowserSession,
		private installBrowserSession: (browserSession: BrowserSession) => void,
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
		private getCurrentWorkingConfiguration: () => TaskWorkingConfiguration,
		private withTaskMutationAuthorization: <T>(
			requestConfiguration: TaskWorkingConfiguration,
			toolName: DiracToolSpec["id"] | undefined,
			mutation: () => Promise<T>,
		) => Promise<T>,
		private transitionFromMutation: <T>(transition: () => Promise<T>) => Promise<T>,
		private retainMutationUntil: (completion: Promise<void>) => void,
		private commitEnabledToolToggles: (toolIds: readonly string[], finalize?: () => Promise<void>) => Promise<void>,
		private saveCheckpoint: (isAttemptCompletionMessage?: boolean, completionMessageId?: string) => Promise<void>,
		private commitAttemptCompletion: (response: string) => Promise<
			import("./tools/interfaces/IToolEnvironment").CompletionCommitResult
		>,
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
		private notifyContextCompacted: () => void,
		private executionProfile: TaskExecutionProfile,
		private environmentFactory: ToolEnvironmentFactory,
		private toolSelectionPolicy: import("./tools/runtime/ToolSelectionPolicy").ToolSelectionPolicy | undefined,
		private storageAddress?: TaskStorageAddress,
	) {
		this.coordinator = new ToolExecutorCoordinator(environmentFactory)
		this.snapshotManager = new ToolSnapshotManager({
			createTaskConfig: (coordinator) => this.asToolConfig(coordinator),
			getTaskId: () => this.taskId,
			getWorkspaceRoot: () => this.workspaceManager?.getPrimaryRoot()?.path,
			getToggles: () => this.requestRuntime().workingConfiguration.settings.toolToggles || {},
			getSelectionPolicy: () => this.toolSelectionPolicy,
			getActiveSkills: () => {
				const activeIds = new Set(this.taskState.activeSkillIds)
				return this.taskState.availableSkills.filter((skill) => activeIds.has(skill.name))
			},
			isToolAvailable: (tool) => isDiscoveredToolAvailableToTaskProfile(this.executionProfile, tool),
			environmentFactory: this.environmentFactory,
		})
		this.hookRunner = new ToolHookRunner(
			taskState,
			messageStateHandler,
			taskMessenger,
			taskId,
			setActiveHookExecution,
			clearActiveHookExecution,
		)
		this.resultPusher = new ToolResultPusher(taskState)
		this.errorHandler = new ToolErrorHandler(taskState, taskMessenger)
	}

	public setApi(api: ApiHandler): void {
		this.api = api
	}

	private requestAutoApprover(): AutoApprove {
		return new AutoApprove(
			this.commandPermissionController,
			() => this.getCurrentWorkingConfiguration().settings,
			this.getCurrentWorkingConfiguration().executionOptions.multiRootEnabled,
			this.executionProfile === "tasklet",
		)
	}

	private shouldAutoApproveTool(toolName: DiracDefaultTool): boolean | [boolean, boolean] {
		return this.requestAutoApprover().shouldAutoApproveTool(toolName)
	}

	private assertMutationAuthorized(toolName?: DiracToolSpec["id"]): void {
		assertTaskMutationAuthorized(this.requestRuntime().workingConfiguration, this.getCurrentWorkingConfiguration(), toolName)
	}

	private withMutationAuthorization<T>(toolName: DiracToolSpec["id"] | undefined, mutation: () => Promise<T>): Promise<T> {
		return this.withTaskMutationAuthorization(this.requestRuntime().workingConfiguration, toolName, mutation)
	}

	private async shouldAutoApproveToolWithPath(
		blockname: DiracToolSpec["id"],
		autoApproveActionpath: string | undefined,
	): Promise<boolean> {
		if (!Object.values(DiracDefaultTool).includes(blockname as DiracDefaultTool)) return false
		const approved = await this.requestAutoApprover().shouldAutoApproveToolWithPath(
			blockname as DiracDefaultTool,
			autoApproveActionpath,
		)
		this.assertMutationAuthorized(blockname)
		return approved
	}

	private async resolveToolPathPermission(
		blockname: DiracToolSpec["id"],
		autoApproveActionpath: string | undefined,
	): Promise<ToolPermissionDisposition> {
		if (!Object.values(DiracDefaultTool).includes(blockname as DiracDefaultTool)) return "manual_only"
		const disposition = await this.requestAutoApprover().resolveToolPathPermission(
			blockname as DiracDefaultTool,
			autoApproveActionpath,
		)
		this.assertMutationAuthorized(blockname)
		return disposition
	}

	private requestRuntime(): TaskRequestRuntime {
		const runtime = this.buildingRequestRuntime ?? this.activeRequestRuntime
		if (!runtime) throw new Error("Tool execution has no request-bound runtime")
		if (runtime.toolSnapshot && runtime.toolSnapshot.requestId !== runtime.requestId) {
			throw new Error("Active tool snapshot does not belong to the request-bound runtime")
		}
		return runtime
	}

	private requestProviderId(runtime = this.requestRuntime()): string {
		const { mode } = runtime.workingConfiguration.settings
		const configuration = runtime.workingConfiguration.apiConfiguration
		return ((mode === "plan" ? configuration.planModeApiProvider : configuration.actModeApiProvider) ??
			configuration.apiProvider ??
			"unknown") as string
	}

	private createUtilityRunner(
		selection: ModelProviderSelection,
		options: Parameters<typeof createUtilityModelRunner>[2] = {},
		apiConfiguration = this.requestRuntime().workingConfiguration.apiConfiguration,
	) {
		const observer = options.onUsage
		return createUtilityModelRunner(apiConfiguration as ApiConfiguration, selection, {
			...options,
			ulid: this.ulid,
			onUsage: (event) => {
				recordUtilityModelUsage(this.taskState, this.ulid, event)
				observer?.(event)
			},
		})
	}


	private createPermissionDecisionBinding(
		configuration = this.requestRuntime().workingConfiguration,
	): PermissionDecisionServiceBinding | undefined {
		const settings = configuration.settings
		if (!settings.utilityModelUsePermissionHandling) return undefined
		if (typeof settings.utilityModelPermissionPolicy !== "string" || settings.utilityModelPermissionPolicy.trim() === "") {
			return undefined
		}

		const selection = getConfiguredUtilityModelSelection(settings.utilityModelSelection)
		if (!selection) return undefined

		return {
			service: new UtilityPermissionDecisionService(
				this.createUtilityRunner(selection, {}, configuration.apiConfiguration),
				settings.utilityModelPermissionPolicy,
				(error) => Logger.warn("Utility permission decision failed; escalating to the user", error),
			),
			configurationRevision: configuration.revision,
		}
	}

	private createSubagentRuntime(options: {
		modelId?: string
		utilityModelSelection?: ModelProviderSelection
	}): SubagentRuntime {
		const requestRuntime = this.requestRuntime()
		const configuration = requestRuntime.workingConfiguration.apiConfiguration as ApiConfiguration
		let handler: ApiHandler
		let providerId: string
		if (options.utilityModelSelection) {
			handler = buildApiHandlerForSelection(configuration, options.utilityModelSelection, { ulid: this.ulid })
			providerId = options.utilityModelSelection.provider
		} else {
			const mode = requestRuntime.workingConfiguration.settings.mode
			const candidate = { ...configuration, ulid: this.ulid } as ApiConfiguration
			providerId = ((mode === "plan" ? candidate.planModeApiProvider : candidate.actModeApiProvider) ??
				candidate.apiProvider ??
				"unknown") as string
			const modelId = options.modelId?.trim()
			if (modelId && providerId !== "unknown") {
				; (candidate as Record<string, unknown>)[getProviderModelIdKey(providerId as ApiProvider, mode)] = modelId
			}
			handler = buildApiHandler(candidate, mode)
		}

		return Object.freeze({
			providerId,
			model: deepFreezeConfiguration(structuredClone(handler.getModel())),
			supportsNativeWebSearch: handler.supportsNativeWebSearch?.() === true,
			createMessage: handler.createMessage.bind(handler),
			abort: () => handler.abort?.(),
		})
	}

	private asToolConfig(coordinator = this.coordinator): TaskConfig {
		const runtime = this.requestRuntime()
		const settings = runtime.workingConfiguration.settings
		const currentSettings = () => this.getCurrentWorkingConfiguration().settings
		const currentPermissionDecisionBinding = () =>
			this.createPermissionDecisionBinding(this.getCurrentWorkingConfiguration())
		const autoApprover = this.requestAutoApprover()
		const config: TaskConfig = {
			executionProfile: this.executionProfile,
			taskId: this.taskId,
			storageAddress: this.storageAddress,
			ulid: this.ulid,
			mode: settings.mode,
			strictPlanModeEnabled: settings.strictPlanModeEnabled,
			get yoloModeToggled() {
				return !autoApprover.requiresCounterpartyApproval && currentSettings().yoloModeToggled
			},
			lowVerbosityEnabled: settings.lowVerbosityEnabled,
			vscodeTerminalExecutionMode: this.terminalExecutionMode,
			enableParallelToolCalling: settings.enableParallelToolCalling,
			isSubagentExecution: false,
			backgroundEditEnabled: !!settings.backgroundEditEnabled,
			providerId: this.requestProviderId(),
			customPrompt: settings.customPrompt,
			hooksEnabled: settings.hooksEnabled,
			subagentsEnabled: settings.subagentsEnabled,
			useAutoCondense: settings.useAutoCondense,
			utilityModelEnabled: settings.utilityModelEnabled,
			utilityModelUseCondense: settings.utilityModelUseCondense,
			utilityModelSelection: settings.utilityModelSelection
				? (structuredClone(settings.utilityModelSelection) as ModelProviderSelection)
				: undefined,
			globalSkillsToggles: settings.globalSkillsToggles,
			localSkillsToggles: runtime.workingConfiguration.workspaceConfiguration.localSkillsToggles,
			context: this.diracContext,
			cwd: this.cwd,
			workspaceManager: this.workspaceManager,
			isMultiRootEnabled: this.isMultiRootEnabled,
			taskState: this.taskState,
			messageState: this.messageStateHandler,
			model: deepFreezeConfiguration(structuredClone(runtime.api.getModel())),
			supportsNativeWebSearch: runtime.api.supportsNativeWebSearch?.() === true,
			get autoApprovalSettings() {
				return currentSettings().autoApprovalSettings as TaskConfig["autoApprovalSettings"]
			},
			autoApprover,
			browserSettings: settings.browserSettings,
			get permissionDecisionBinding() {
				return autoApprover.requiresCounterpartyApproval ? undefined : currentPermissionDecisionBinding()
			},
			services: {
				browserSession: this.browserSession,
				urlContentFetcher: this.urlContentFetcher,
				diffViewProvider: this.diffViewProvider,
				fileContextTracker: this.fileContextTracker,
				diracIgnoreController: this.diracIgnoreController,
				commandPermissionController: this.commandPermissionController,
				contextManager: this.contextManager,
			},
			callbacks: {
				assertMutationAuthorized: (toolName) => this.assertMutationAuthorized(toolName),
				withMutationAuthorization: (toolName, mutation) => this.withMutationAuthorization(toolName, mutation),
				transitionFromMutation: (transition) => this.transitionFromMutation(transition),
				retainMutationUntil: (completion) => this.retainMutationUntil(completion),
				commitEnabledToolToggles: (toolIds, finalize) => this.commitEnabledToolToggles(toolIds, finalize),
				saveCheckpoint: async (isAttemptCompletionMessage?: boolean, completionMessageId?: string) => {
					await this.saveCheckpoint(isAttemptCompletionMessage, completionMessageId)
				},
				commitAttemptCompletion: (response) => this.commitAttemptCompletion(response),
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
				resolveToolPathPermission: this.resolveToolPathPermission.bind(this),
				applyLatestBrowserSettings: this.applyLatestBrowserSettings.bind(this),
				switchToActMode: this.switchToActMode,
				setActiveHookExecution: this.setActiveHookExecution,
				clearActiveHookExecution: this.clearActiveHookExecution,
				getActiveHookExecution: this.getActiveHookExecution,
				runUserPromptSubmitHook: this.runUserPromptSubmitHook,
				resetTransientState: this.resetTransientState,
				notifyContextCompacted: this.notifyContextCompacted,
				createUtilityModelRunner: (selection, options) => this.createUtilityRunner(selection, options),
				createSubagentRuntime: (options) => this.createSubagentRuntime(options),
			},
			coordinator,
			taskMessenger: this.taskMessenger,
		}
		config.activeToolSnapshot = runtime.toolSnapshot
		validateTaskConfig(config)
		return config
	}

	public async refreshToolsForTask(): Promise<void> {
		this.markToolsDirty("task_start")
	}
	public markToolsDirty(reason: ToolSnapshotDirtyReason): void {
		this.snapshotManager.markDirty(reason)
	}
	public async getSnapshotForRequest(
		context: SystemPromptContext,
		requestRuntime: TaskRequestRuntime,
	): Promise<ToolRequestSnapshot> {
		this.buildingRequestRuntime = requestRuntime
		try {
			return await this.snapshotManager.getSnapshotForRequest(context, {
				requestId: requestRuntime.requestId,
				configurationRevision: requestRuntime.workingConfiguration.revision,
			})
		} finally {
			this.buildingRequestRuntime = undefined
		}
	}
	public getActiveSnapshot(): ToolRequestSnapshot | undefined {
		return this.snapshotManager.getActiveSnapshot()
	}
	public activateSnapshot(snapshot: ToolRequestSnapshot, requestRuntime: TaskRequestRuntime): void {
		if (snapshot.requestId !== requestRuntime.requestId)
			throw new Error("Cannot activate a tool snapshot for another request")
		if (
			snapshot.configurationRevision !== undefined &&
			snapshot.configurationRevision !== requestRuntime.workingConfiguration.revision
		) {
			throw new Error("Cannot activate a tool snapshot for another configuration revision")
		}
		this.activeRequestRuntime = requestRuntime
		this.snapshotManager.activateSnapshot(snapshot)
		this.coordinator = snapshot.coordinator
	}
	public async executeTool(block: ToolUse, isComplete = true): Promise<void> {
		await this.execute(block, isComplete)
	}

	public async applyLatestBrowserSettings() {
		if (this.taskState.abort) throw new Error("Cannot replace browser session after task abort")
		const runtime = this.requestRuntime()
		await this.browserSession.dispose()
		if (this.taskState.abort) throw new Error("Cannot replace browser session after task abort")
		const useWebp = !modelDoesntSupportWebp(runtime.api.getModel())
		const replacement = new BrowserSession(runtime.workingConfiguration.settings.browserSettings, useWebp)
		replacement.setUlid(this.ulid)
		try {
			this.installBrowserSession(replacement)
		} catch (error) {
			await replacement.dispose()
			throw error
		}
		this.browserSession = replacement
		return replacement
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
		try {
			canonicalizeResponseToolCall(block, isComplete)
			if (!this.coordinator.has(block.name)) return false
			const config = this.asToolConfig()
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
		if (!block.name || !this.isPlanModeToolRestricted(block.name as DiracDefaultTool)) return false
		try {
			this.assertMutationAuthorized(block.name as DiracDefaultTool)
			return false
		} catch {
			// Present the established Plan-mode rejection below.
		}
		const errorMessage = `Tool '${block.name}' is not available in PLAN MODE. This tool is restricted to ACT MODE for file modifications. Only use tools available for PLAN MODE when in that mode.`
		await this.taskMessenger.createCard({ header: "Plan Mode Restriction", body: errorMessage, status: CardStatus.ERROR })
		if (isComplete) await this.resultPusher.pushToolResult(formatResponse.toolError(errorMessage), block)
		return true
	}

	private async handleCompleteBlock(block: ToolUse, config: any): Promise<void> {
		if (this.taskState.abort) return
		const requestRuntime = this.requestRuntime()
		const providerId = this.requestProviderId(requestRuntime)
		const hooksEnabled = getHooksEnabledSafe(requestRuntime.workingConfiguration.settings.hooksEnabled)
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
			await this.resultPusher.pushToolResult(toolResult, block)
			if (this.taskState.abort) return
			if (hooksEnabled && !isCompletionResponseCall(block)) {
				if (
					await this.hookRunner.runPostToolUseHook(
						block,
						toolResult,
						executionSuccess,
						executionStartTime,
						hooksEnabled,
						requestRuntime.api,
						providerId,
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
			if (toolWasExecuted && hooksEnabled && !isCompletionResponseCall(block)) {
				if (
					await this.hookRunner.runPostToolUseHook(
						block,
						toolResult,
						executionSuccess,
						executionStartTime,
						hooksEnabled,
						requestRuntime.api,
						providerId,
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
