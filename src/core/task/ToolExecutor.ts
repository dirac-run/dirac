import type { ApiHandler } from "@core/api"
import { FileContextTracker } from "@core/context/context-tracking/FileContextTracker"
import { formatResponse } from "@core/formatResponse"
import { getHooksEnabledSafe } from "@core/hooks/hooks-utils"
import { HookCleanupError } from "@core/hooks/HookCleanupError"
import { ToolInvocationSettlementError } from "./tools/runtime/ToolInvocationSettlementError"
import type { ToolInvocationResult } from "./tools/interfaces/ToolInvocationResult"
import { createToolExecutionScope } from "./tools/runtime/createToolExecutionScope"
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
import type { ApiConfiguration, ModelProviderSelection } from "@shared/api"
import { CardStatus, DiracMessage } from "@shared/ExtensionMessage"
import { Logger } from "@shared/services/Logger"
import { DiracContent } from "@shared/messages/content"
import { canonicalizeResponseToolCall, isCompletionResponseCall } from "@shared/responseTool"
import { DiracDefaultTool, type DiracToolSpec } from "@shared/tools"
import type { TaskStorageAddress } from "@core/storage/taskDirectory"
import { getTaskScopedStateKey } from "@shared/taskletId"
import { captureSandboxExecution } from "@shared/SandboxExecution"
import { modelDoesntSupportWebp } from "@/utils/model-utils"
import { ToolUse } from "../assistant-message"
import { ContextManager } from "../context/context-management/ContextManager"
import { StateManager } from "../storage/StateManager"
import { WorkspaceRootManager } from "../workspace"
import { MessageStateHandler } from "./message-state"
import { assertTaskMutationAuthorized, type TaskRequestRuntime } from "./runtime/TaskRequestRuntime"
import { getTaskHookModelContext } from "./runtime/TaskRuntimeModelContext"
import { deepFreezeConfiguration, type TaskWorkingConfiguration } from "./runtime/TaskWorkingConfiguration"
import { TaskState } from "./TaskState"
import { recordUtilityModelUsage } from "./recordUtilityModelUsage"
import { AutoApprove, resolveCommandApproval, resolveBrowserLaunchPermission, type ToolPermissionDisposition } from "./tools/autoApprove"
import { IDiracContext } from "./tools/interfaces/IDiracContext"
import { ToolErrorHandler, ToolHookRunner } from "./tools/runtime/ToolHookRunner"
import { ToolResultPusher } from "./tools/runtime/ToolResultPusher"
import type { ToolRequestSnapshot, ToolSnapshotDirtyReason } from "./tools/runtime/ToolSnapshot"
import { ToolSnapshotManager } from "./tools/runtime/ToolSnapshotManager"
import { ToolExecutorCoordinator } from "./tools/ToolExecutorCoordinator"
import type { ToolEnvironmentFactory } from "./tools/interfaces/ToolEnvironmentFactory"
import { TaskConfig, validateTaskConfig } from "./tools/types/TaskConfig"
import { ToolDisplayUtils } from "./tools/utils/ToolDisplayUtils"
import type { TaskExecutionProfile } from "./TaskExecutionProfile"
import { isDiscoveredToolAvailableToTaskProfile } from "./TaskExecutionProfile"
import type { TaskInteractionRequest } from "./types/task-messenger"

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
	private toolSnapshotSubagentsEnabled?: boolean

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
		private setActiveHookExecution: (hookExecution: import("./types/HookExecution").HookExecution) => Promise<void>,
		private clearActiveHookExecution: (messageId: string) => Promise<void>,
		private getActiveHookExecution: (messageId: string) => Promise<import("./types/HookExecution").HookExecution | undefined>,
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
		private getTaskletControls?: () => import("./tools/interfaces/IToolEnvironment").TaskletControls | undefined,
		private onUtilityUsageRecorded?: () => void,
		private getPermissionWorkingConfiguration?: () => TaskWorkingConfiguration,
		private getAgentCommunication?: () => import("./AgentCommunication").AgentCommunicationCapability | undefined,
		private getAgentWait?: () => import("./AgentCommunication").AgentWaitCapability | undefined,
		private getSharedJournal?: () => import("./SharedJournalTypes").SharedJournalCapability | undefined,
		private getPermissionCommandController?: () => CommandPermissionController,
		private getCommandApprovals?: () => import("./tools/interfaces/CommandApprovals").CommandApprovalsCapability | undefined,
		private captureTaskCommandSandbox?: () => import("@shared/SandboxExecution").SandboxExecutionContext,
		private readonly agentRole?: string,
	) {
		this.coordinator = new ToolExecutorCoordinator(environmentFactory)
		this.snapshotManager = new ToolSnapshotManager({
			createTaskConfig: (coordinator) => this.asToolConfig(coordinator),
			getTaskToolOwnerKey: () => getTaskScopedStateKey(this.taskId, this.storageAddress),
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

	private permissionCommandController(): CommandPermissionController {
		return this.getPermissionCommandController?.() ?? this.commandPermissionController
	}

	private requestAutoApprover(): AutoApprove {
		return new AutoApprove(
			this.permissionCommandController(),
			() => (this.getPermissionWorkingConfiguration ?? this.getCurrentWorkingConfiguration)().settings,
			(this.getPermissionWorkingConfiguration ?? this.getCurrentWorkingConfiguration)().executionOptions.multiRootEnabled,
			this.executionProfile === "tasklet",
		)
	}

	/** A user escalation cannot override the root's current strict-Plan mutation boundary. */
	public assertTaskletPermissionAllowed(request: TaskInteractionRequest): void {
		const tool = request.toolCall?.name as DiracDefaultTool | undefined
		if (tool && ToolExecutor.PLAN_MODE_RESTRICTED_TOOLS.includes(tool)) {
			const current = this.getCurrentWorkingConfiguration()
			assertTaskMutationAuthorized(this.activeRequestRuntime?.workingConfiguration ?? current, current, tool)
		}
	}

	/** Checks authority only after an explicit parent approval; never decides for the parent. */
	public async authorizeTaskletPermission(
		request: TaskInteractionRequest,
		signal: AbortSignal,
	): Promise<{ approved: boolean; assertCurrent: () => void }> {
		const configuration = this.getCurrentWorkingConfiguration()
		const permissionRevision = this.permissionCommandController().revision
		const assertCurrent = () => {
			signal.throwIfAborted()
			this.assertTaskletPermissionAllowed(request)
			if (this.getCurrentWorkingConfiguration().revision !== configuration.revision ||
				this.permissionCommandController().revision !== permissionRevision) {
				throw new Error("Parent authority changed while resolving tasklet permission")
			}
		}
		assertCurrent()
		const operation = request.permissionOperation
		if (!operation || !request.toolCall) return { approved: false, assertCurrent }
		const binding = this.createPermissionDecisionBinding(configuration)
		const autoApprover = this.requestAutoApprover()
		const disposition = await this.taskletPermissionDisposition(request, autoApprover, !!binding)
		assertCurrent()
		if (disposition === "auto_approve") return { approved: true, assertCurrent }
		if (disposition !== "utility_eligible" || !binding || request.utilityPermissionEscalation !== undefined) {
			return { approved: false, assertCurrent }
		}
		const decision = await binding.service.decide({
			toolCall: structuredClone(request.toolCall),
			permission: {
				header: request.card.header,
				operation: structuredClone(operation),
				...(request.card.locations ? { locations: structuredClone(request.card.locations) } : {}),
				...(request.card.diffs ? { diffs: structuredClone(request.card.diffs) } : {}),
			},
			runtime: { cwd: this.cwd, mode: binding.authorityMode, isSubagent: true },
		}, signal)
		assertCurrent()
		return { approved: decision.decision === "approve", assertCurrent }
	}

	private async taskletPermissionDisposition(
		request: TaskInteractionRequest,
		autoApprover: AutoApprove,
		utilityEnabled: boolean,
	): Promise<ToolPermissionDisposition> {
		const operation = request.permissionOperation!
		const tool = request.toolCall!.name as DiracDefaultTool
		switch (operation.kind) {
			case "commands": {
				if ((tool !== DiracDefaultTool.EXECUTE_COMMAND && tool !== DiracDefaultTool.UPSERT_TOOL) || !operation.commands.length) {
					return "manual_only"
				}
				// Classified permission cards apply the shared unrestricted override even when
				// the tool's initial disposition is manual-only (including Utility restrictions).
				if (autoApprover.isUnrestrictedAutoApprove()) return "auto_approve"
				const approval = resolveCommandApproval(operation.commands, utilityEnabled, autoApprover, this.permissionCommandController())
				return !approval.required ? "auto_approve" : approval.utilityEligible ? "utility_eligible" : "manual_only"
			}
			case "browser":
				if (tool !== DiracDefaultTool.BROWSER) return "manual_only"
				if (autoApprover.isUnrestrictedAutoApprove()) return "auto_approve"
				return utilityEnabled
					? resolveBrowserLaunchPermission(operation.url, autoApprover, this.permissionCommandController())
					: autoApprover.isUnrestrictedAutoApprove() ? "auto_approve" : "manual_only"
			case "paths": {
				if (!ToolExecutor.PLAN_MODE_RESTRICTED_TOOLS.includes(tool) || !operation.paths.length) return "manual_only"
				if (autoApprover.isUnrestrictedAutoApprove()) return "auto_approve"
				let result: ToolPermissionDisposition = "auto_approve"
				for (const path of operation.paths) {
					const disposition = utilityEnabled
						? await autoApprover.resolveToolPathPermission(tool, path)
						: await autoApprover.shouldAutoApproveToolWithPath(tool, path) ? "auto_approve" : "manual_only"
					if (disposition === "manual_only") return disposition
					if (disposition === "utility_eligible") result = disposition
				}
				return result
			}
			case "tool":
				// Built-ins with resolved scopes must not fall back to a generic grant if metadata is missing.
				if (ToolExecutor.PLAN_MODE_RESTRICTED_TOOLS.includes(tool) ||
					tool === DiracDefaultTool.EXECUTE_COMMAND || tool === DiracDefaultTool.BROWSER) return "manual_only"
				if (autoApprover.isUnrestrictedAutoApprove()) return "auto_approve"
				return operation.manualOnly ? "manual_only" : "utility_eligible"
		}
	}

	private shouldAutoApproveTool(toolName: DiracDefaultTool): boolean | [boolean, boolean] {
		return this.requestAutoApprover().shouldAutoApproveTool(toolName)
	}

	private assertMutationAuthorized(toolName?: DiracToolSpec["id"], runtime = this.requestRuntime()): void {
		assertTaskMutationAuthorized(runtime.workingConfiguration, this.getCurrentWorkingConfiguration(), toolName)
	}

	private withMutationAuthorization<T>(toolName: DiracToolSpec["id"] | undefined, mutation: () => Promise<T>, runtime = this.requestRuntime()): Promise<T> {
		return this.withTaskMutationAuthorization(runtime.workingConfiguration, toolName, mutation)
	}

	private async shouldAutoApproveToolWithPath(
		blockname: DiracToolSpec["id"],
		autoApproveActionpath: string | undefined,
		runtime = this.requestRuntime(),
	): Promise<boolean> {
		if (!Object.values(DiracDefaultTool).includes(blockname as DiracDefaultTool)) return false
		const approved = await this.requestAutoApprover().shouldAutoApproveToolWithPath(
			blockname as DiracDefaultTool,
			autoApproveActionpath,
		)
		this.assertMutationAuthorized(blockname, runtime)
		return approved
	}

	private async resolveToolPathPermission(
		blockname: DiracToolSpec["id"],
		autoApproveActionpath: string | undefined,
		runtime = this.requestRuntime(),
	): Promise<ToolPermissionDisposition> {
		if (!Object.values(DiracDefaultTool).includes(blockname as DiracDefaultTool)) return "manual_only"
		const disposition = await this.requestAutoApprover().resolveToolPathPermission(
			blockname as DiracDefaultTool,
			autoApproveActionpath,
		)
		this.assertMutationAuthorized(blockname, runtime)
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
				this.onUtilityUsageRecorded?.()
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
				(error) => Logger.warn("Utility permission decision failed; escalating the request", error),
			),
			configurationRevision: configuration.revision,
			authorityMode: settings.mode,
			commandPermissionRevision: this.permissionCommandController().revision,
		}
	}


	private asToolConfig(coordinator = this.coordinator, runtime = this.requestRuntime()): TaskConfig {
		const settings = runtime.workingConfiguration.settings
		const permissionConfiguration = () => (this.getPermissionWorkingConfiguration ?? this.getCurrentWorkingConfiguration)()
		const currentSettings = () => permissionConfiguration().settings
		const currentPermissionDecisionBinding = () => this.createPermissionDecisionBinding(permissionConfiguration())
		const autoApprover = this.requestAutoApprover()
		const permissionCommandController = () => this.permissionCommandController()
		const config: TaskConfig = {
			executionProfile: this.executionProfile,
			taskId: this.taskId,
			agentRole: this.agentRole,
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
			backgroundEditEnabled: !!settings.backgroundEditEnabled,
			providerId: this.requestProviderId(runtime),
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
				return currentPermissionDecisionBinding()
			},
			services: {
				browserSession: this.browserSession,
				urlContentFetcher: this.urlContentFetcher,
				diffViewProvider: this.diffViewProvider,
				fileContextTracker: this.fileContextTracker,
				diracIgnoreController: this.diracIgnoreController,
				get commandPermissionController() {
					return permissionCommandController()
				},
				contextManager: this.contextManager,
			},
			callbacks: {
				tasklets: this.executionProfile !== "tasklet" ? this.getTaskletControls?.() : undefined,
				agentCommunication: this.getAgentCommunication?.(),
				agentWait: this.executionProfile === "tasklet" ? this.getAgentWait?.() : undefined,
				sharedJournal: this.getSharedJournal?.(),
				commandApprovals: this.getCommandApprovals?.(),
				assertMutationAuthorized: (toolName) => this.assertMutationAuthorized(toolName, runtime),
				withMutationAuthorization: (toolName, mutation) => this.withMutationAuthorization(toolName, mutation, runtime),
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
				captureCommandSandbox: () => this.captureTaskCommandSandbox?.() ?? captureSandboxExecution(
					this.stateManager.getSystemDefaultSettingsKey("sandboxSettings"), this.executionProfile === "tasklet",
				),
				cancelRunningCommandTool: this.cancelRunningCommandTool,
				doesLatestTaskCompletionHaveNewChanges: this.doesLatestTaskCompletionHaveNewChanges,
				getDiracMessages: () => this.messageStateHandler.getDiracMessages(),
				updateDiracMessage: async (index: number, updates: Partial<DiracMessage>) => {
					await this.messageStateHandler.updateDiracMessage(index, updates)
					await config.callbacks.postStateToWebview()
				},
				shouldAutoApproveTool: this.shouldAutoApproveTool.bind(this),
				shouldAutoApproveToolWithPath: (toolName, path) => this.shouldAutoApproveToolWithPath(toolName, path, runtime),
				resolveToolPathPermission: (toolName, path) => this.resolveToolPathPermission(toolName, path, runtime),
				applyLatestBrowserSettings: () => this.applyLatestBrowserSettings(runtime),
				switchToActMode: this.switchToActMode,
				setActiveHookExecution: this.setActiveHookExecution,
				clearActiveHookExecution: this.clearActiveHookExecution,
				getActiveHookExecution: this.getActiveHookExecution,
				runUserPromptSubmitHook: this.runUserPromptSubmitHook,
				resetTransientState: this.resetTransientState,
				notifyContextCompacted: this.notifyContextCompacted,
				createUtilityModelRunner: (selection, options) => this.createUtilityRunner(selection, options, runtime.workingConfiguration.apiConfiguration),
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
			const subagentsEnabled = requestRuntime.workingConfiguration.settings.subagentsEnabled === true
			if (this.toolSnapshotSubagentsEnabled !== subagentsEnabled) {
				this.markToolsDirty("tool_toggles_changed")
			}
			this.toolSnapshotSubagentsEnabled = subagentsEnabled
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

	public async applyLatestBrowserSettings(runtime?: TaskRequestRuntime) {
		if (this.taskState.abort) throw new Error("Cannot replace browser session after task abort")
		runtime ??= this.requestRuntime()
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
			const runtime = this.requestRuntime()
			const coordinator = this.coordinator
			if (!coordinator.has(block.name)) return false
			const config = this.asToolConfig(coordinator, runtime)
			if (this.taskState.didRejectTool) {
				const reason = !isComplete
					? "Tool was interrupted and not executed due to user rejecting a previous tool."
					: "Skipping tool due to user rejecting a previous tool."
				this.createToolRejectionMessage(block, reason)
				return true
			}
			if (await this.isPlanModeRestricted(block, isComplete, runtime)) return true
			if (block.name !== "browser_action") await this.browserSession.closeBrowser()
			if (!isComplete) {
				await coordinator.bufferPartialToolUse(block, config)
				return true
			}
			await this.handleCompleteBlock(block, config, runtime)
			return true
		} catch (error) {
			// Ownership/settlement failures must stop the task, not produce a replacement native result.
			if (error instanceof HookCleanupError || error instanceof ToolInvocationSettlementError) throw error
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
	private async isPlanModeRestricted(block: ToolUse, isComplete = true, runtime = this.requestRuntime()): Promise<boolean> {
		if (!block.name || !this.isPlanModeToolRestricted(block.name as DiracDefaultTool)) return false
		try {
			this.assertMutationAuthorized(block.name as DiracDefaultTool, runtime)
			return false
		} catch {
			// Present the established Plan-mode rejection below.
		}
		const errorMessage = `Tool '${block.name}' is not available in PLAN MODE. This tool is restricted to ACT MODE for file modifications. Only use tools available for PLAN MODE when in that mode.`
		await this.taskMessenger.createCard({ header: "Plan Mode Restriction", body: errorMessage, status: CardStatus.ERROR })
		if (isComplete) await this.resultPusher.pushToolResult(formatResponse.toolError(errorMessage), block)
		return true
	}

	private async handleCompleteBlock(block: ToolUse, config: TaskConfig, requestRuntime: TaskRequestRuntime): Promise<void> {
		if (this.taskState.abort) return
		let result: ToolInvocationResult
		let settlementFailure: ToolInvocationSettlementError | undefined
		try {
			result = await this.runInvocation(block, config, requestRuntime)
		} catch (error) {
			if (!(error instanceof ToolInvocationSettlementError)) throw error
			result = error.operationResult
			settlementFailure = error
		}
		const { effects } = result
		if (effects.mistake === "increment") this.taskState.consecutiveMistakeCount++
		if (effects.mistake === "reset") this.taskState.consecutiveMistakeCount = 0
		if (effects.userInput) {
			this.taskState.didRejectTool = true
			this.taskState.pendingUserMessage = effects.userInput.message
			this.taskState.pendingUserImages = effects.userInput.images
			this.taskState.pendingUserFiles = effects.userInput.files
		}
		const count = ++this.taskState.totalToolCallCount
		await this.resultPusher.pushToolResult(ToolResultPusher.appendLoopWarning(result.content, count), block)
		if (effects.context) this.taskState.userMessageContent.push(...effects.context)
		if (effects.cancelTask) await config.callbacks.cancelTask()
		if (settlementFailure) throw settlementFailure
	}

	/** Capture implementation and request attribution before admission or any asynchronous wait. */
	public prepareInvocation(block: ToolUse, runtime = this.requestRuntime()) {
		const captured = structuredClone(block)
		canonicalizeResponseToolCall(captured, true)
		const coordinator = runtime.toolSnapshot?.coordinator ?? this.coordinator
		if (!coordinator.has(captured.name)) throw new Error(`Unknown tool: ${captured.name}`)
		const config = this.asToolConfig(coordinator, runtime)
		return {
			block: deepFreezeConfiguration(structuredClone(captured)),
			requestId: runtime.requestId,
			run: (execution: import("./tools/interfaces/ToolExecutionScope").ToolExecutionScopeContext) => {
				if (execution.identity.requestId !== runtime.requestId || execution.identity.toolName !== captured.name) {
					throw new Error("Execution scope does not match its captured invocation")
				}
				const scopedConfig = Object.create(Object.getPrototypeOf(config), Object.getOwnPropertyDescriptors(config)) as TaskConfig
				Object.defineProperty(scopedConfig, "execution", { value: createToolExecutionScope(execution), enumerable: true })
				Object.defineProperty(scopedConfig, "messengerContext", {
					value: Object.freeze({
						executionId: execution.identity.executionId,
						signal: execution.signal,
						hooksEnabled: getHooksEnabledSafe(runtime.workingConfiguration.settings.hooksEnabled),
						hookModel: getTaskHookModelContext(runtime.api, runtime.workingConfiguration),
					}),
					enumerable: true,
				})
				return this.runInvocation(captured, scopedConfig, runtime)
			},
		}
	}

	/** Execution-only path: returns effects; it never appends to the current model turn. */
	private async runInvocation(
		block: ToolUse,
		config: TaskConfig,
		runtime: TaskRequestRuntime,
	): Promise<ToolInvocationResult> {
		const signal = config.execution
			? AbortSignal.any([config.execution.signal, this.taskState.abortSignal])
			: this.taskState.abortSignal
		signal.throwIfAborted()
		const executionStartTime = Date.now()
		if (this.isPlanModeToolRestricted(block.name as DiracDefaultTool)) {
			config.callbacks.assertMutationAuthorized(block.name)
		}
		const result = await config.coordinator.execute(config, block)
		const hooksEnabled = getHooksEnabledSafe(runtime.workingConfiguration.settings.hooksEnabled)
		// Cancellation before hook startup is not a failed hook settlement; preserve settled operation effects.
		if (!hooksEnabled || isCompletionResponseCall(block) || result.preStartVeto || signal.aborted) return result
		let hook: Awaited<ReturnType<ToolHookRunner["runPostToolUseHook"]>>
		try {
			hook = await this.hookRunner.runPostToolUseHook(
				block, result.content, result.outcome === "success", executionStartTime,
				hooksEnabled, runtime.api, this.requestProviderId(runtime), signal, config.messengerContext,
			)
		} catch (error) {
			// A cooperatively cancelled hook settled normally; cleanup/persistence failures still propagate.
			if (signal.aborted && error === signal.reason && !(error instanceof HookCleanupError)) return result
			throw new ToolInvocationSettlementError(result, error)
		}
		return {
			...result,
			effects: {
				...result.effects,
				...(hook.context ? { context: [...(result.effects.context ?? []), hook.context] } : {}),
				...(hook.cancelled ? { cancelTask: true } : {}),
			},
		}
	}
}
