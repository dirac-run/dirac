import { ApiHandler } from "@core/api"
import { FileContextTracker } from "@core/context/context-tracking/FileContextTracker"
import { getHookModelContext } from "@core/hooks/hook-model-context"
import { getHooksEnabledSafe } from "@core/hooks/hooks-utils"
import { DiracIgnoreController } from "@core/ignore/DiracIgnoreController"
import { CommandPermissionController } from "@core/permissions"
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
import { formatResponse } from "../prompts/responses"
import { StateManager } from "../storage/StateManager"
import { WorkspaceRootManager } from "../workspace"
import { ToolResponse } from "."
import { DiracUserToolResultContentBlock } from "@shared/messages/content"
import { MessageStateHandler } from "./message-state"
import { TaskState } from "./TaskState"
import { AutoApprove } from "./tools/autoApprove"
import { ToolExecutorCoordinator } from "./tools/ToolExecutorCoordinator"
import { ToolSnapshotManager } from "./tools/runtime/ToolSnapshotManager"
import type { ToolRequestSnapshot, ToolSnapshotDirtyReason } from "./tools/runtime/ToolSnapshot"
import type { SystemPromptContext } from "@core/prompts/system-prompt/types"
import { TaskConfig, validateTaskConfig } from "./tools/types/TaskConfig"
import { IDiracContext } from "./tools/interfaces/IDiracContext"
import { ToolDisplayUtils } from "./tools/utils/ToolDisplayUtils"

export function canonicalizeAttemptCompletionParams(block: ToolUse): boolean {
    if (block.name === DiracDefaultTool.ATTEMPT && !block.params?.result && typeof block.params?.response === "string") {
        block.params.result = block.params.response
        return true
    }

    return false
}

export class ToolExecutor {
    private autoApprover: AutoApprove
    private coordinator: ToolExecutorCoordinator
    private snapshotManager: ToolSnapshotManager

    // Auto-approval methods using the AutoApprove class
    private shouldAutoApproveTool(toolName: DiracDefaultTool): boolean | [boolean, boolean] {
        return this.autoApprover.shouldAutoApproveTool(toolName)
    }

    private async shouldAutoApproveToolWithPath(
        blockname: DiracToolSpec["id"],
        autoApproveActionpath: string | undefined,
    ): Promise<boolean> {
        if (!Object.values(DiracDefaultTool).includes(blockname as DiracDefaultTool)) {
            return false
        }
        return this.autoApprover.shouldAutoApproveToolWithPath(blockname as DiracDefaultTool, autoApproveActionpath)
    }

    constructor(
        // Core Services & Managers
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

        // Configuration & Settings

        private cwd: string,
        private taskId: string,
        private ulid: string,
        private terminalExecutionMode: "vscodeTerminal" | "backgroundExec",

        // Workspace Management
        private workspaceManager: WorkspaceRootManager | undefined,
        private isMultiRootEnabled: boolean,

        // Callbacks to the Task (Entity)
        private saveCheckpoint: (isAttemptCompletionMessage?: boolean, completionMessageId?: string) => Promise<void>,

        private executeCommandTool: (
            command: string,
            timeoutSeconds: number | undefined,
            options?: CommandExecutionOptions,
        ) => Promise<[boolean, any]>,
        private cancelRunningCommandTool: () => Promise<boolean>,
        private doesLatestTaskCompletionHaveNewChanges: () => Promise<boolean>,
        private switchToActMode: () => Promise<boolean>,
        private cancelTask: () => Promise<void>,
        private postStateToWebview: () => Promise<void>,


        // Atomic hook state helpers from Task
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
        })
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

        // Validate the config at runtime to catch any missing properties
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

    /**
     * Main entry point for tool execution - called by Task class
     */
    public async executeTool(block: ToolUse, isComplete: boolean = true): Promise<void> {
        await this.execute(block, isComplete)
    }

    /**
     * Updates the browser settings
     */
    public async applyLatestBrowserSettings() {
        await this.browserSession.dispose()
        const apiHandlerModel = this.api.getModel()
        const useWebp = this.api ? !modelDoesntSupportWebp(apiHandlerModel) : true
        this.browserSession = new BrowserSession(this.stateManager, useWebp)
        return this.browserSession
    }

    private async handleError(action: string, error: Error, block: ToolUse): Promise<void> {
        const errorString = `Error ${action}: ${error.message}`

        await this.taskMessenger.createCard({
            header: "Tool Error",
            body: errorString,
            status: CardStatus.ERROR,
        })

        // Create error response for the tool
        const errorResponse = formatResponse.toolError(errorString)
        this.pushToolResult(errorResponse, block)
    }

    /**
     * Pushes a tool result to the user message content.
     *
     * This is a critical method that:
     * - Formats the tool result appropriately for the API
     * - Adds it to the conversation context
     * - Marks that a tool has been used in this turn
     *
     * @param content The tool response content to add
     * @param block The tool use block that generated this result
     */
    private pushToolResult = async (content: ToolResponse, block: ToolUse) => {
        // 2. Update LLM conversation history
        const toolResultBlocks: DiracUserToolResultContentBlock[] = []
        if (typeof content === "string") {
            toolResultBlocks.push({
                type: "tool_result",
                tool_use_id: block.id || block.call_id || "",
                content: content,
            })
        } else if (Array.isArray(content)) {
            for (const item of content) {
                if (item.type === "text") {
                    toolResultBlocks.push({
                        type: "tool_result",
                        tool_use_id: block.id || block.call_id || "",
                        content: item.text,
                    })
                } else if (item.type === "image") {
                    toolResultBlocks.push({
                        type: "tool_result",
                        tool_use_id: block.id || block.call_id || "",
                        content: [
                            {
                                type: "image",
                                source: item.source,
                            },
                        ],
                    })
                }
            }
        }

        this.taskState.userMessageContent.push(...toolResultBlocks)
    }

    /**
     * Check if parallel tool calling is enabled.
     * Parallel tool calling is enabled if:
     * 1. User has enabled it in settings, OR
     * 2. The current model/provider supports native tool calling and handles parallel tools well
     */
    private isParallelToolCallingEnabled(): boolean {
        const enableParallelSetting = this.stateManager.getGlobalSettingsKey("enableParallelToolCalling")
        const model = this.api.getModel()
        const apiConfig = this.stateManager.getApiConfiguration()
        const mode = this.stateManager.getGlobalSettingsKey("mode")
        const providerId = (mode === "plan" ? apiConfig.planModeApiProvider : apiConfig.actModeApiProvider) as string
        return isParallelToolCallingEnabled(enableParallelSetting, { providerId, model, mode })
    }

    /**
     * Tools that are restricted in plan mode and can only be used in act mode
     */
    private static readonly PLAN_MODE_RESTRICTED_TOOLS: DiracDefaultTool[] = [
        DiracDefaultTool.FILE_NEW,
        DiracDefaultTool.EDIT_FILE,
        DiracDefaultTool.NEW_RULE,
    ]

    private async execute(block: ToolUse, isComplete: boolean = true): Promise<boolean> {
        // The toolUseIdMap is updated at the point of transformation in index.ts

        if (!this.coordinator.has(block.name)) {
            return false // Tool not handled by coordinator
        }

        canonicalizeAttemptCompletionParams(block)

        const config = this.asToolConfig()

        try {
            // Check if user rejected a previous tool
            if (this.taskState.didRejectTool) {
                const reason = !isComplete
                    ? "Tool was interrupted and not executed due to user rejecting a previous tool."
                    : "Skipping tool due to user rejecting a previous tool."

                this.createToolRejectionMessage(block, reason)
                return true
            }

            // Logic for plan-mode tool call restrictions
            if (
                this.stateManager.getGlobalSettingsKey("strictPlanModeEnabled") &&
                this.stateManager.getGlobalSettingsKey("mode") === "plan" &&
                block.name &&
                this.isPlanModeToolRestricted(block.name as DiracDefaultTool)
            ) {
                const errorMessage = `Tool '${block.name}' is not available in PLAN MODE. This tool is restricted to ACT MODE for file modifications. Only use tools available for PLAN MODE when in that mode.`
                await this.taskMessenger.createCard({
                    header: "Plan Mode Restriction",
                    body: errorMessage,
                    status: CardStatus.ERROR,
                })
                // Only push the final error message when the streaming is done.
                if (isComplete) {
                    this.pushToolResult(formatResponse.toolError(errorMessage), block)
                }
                return true
            }

            // Close browser for non-browser tools
            if (block.name !== "browser_action") {
                await this.browserSession.closeBrowser()
            }

            // Handle partial blocks

            if (!isComplete) {
                await this.handlePartialBlock(block, config)
                return true
            }

            // Handle complete blocks

            await this.handleCompleteBlock(block, config)

            return true
        } catch (error) {
            await this.handleError(`executing ${block.name}`, error as Error, block)
            return true
        }
    }

    /**
     * Check if a tool is restricted in plan mode.
     *
     * In strict plan mode, file modification tools (write_to_file, editedExistingFile, etc.)
     * are blocked. The AI must switch to Act mode to use these tools.
     *
     * @param toolName The name of the tool to check
     * @returns true if the tool is restricted in plan mode, false otherwise
     */
    private isPlanModeToolRestricted(toolName: DiracDefaultTool): boolean {
        return ToolExecutor.PLAN_MODE_RESTRICTED_TOOLS.includes(toolName)
    }

    /**
     * Create a tool rejection message and add it to user message content.
     *
     * Used when a tool cannot be executed (e.g., user rejected a previous tool,
     * tool was interrupted, etc.). Adds a text message to the conversation explaining
     * why the tool was not executed.
     *
     * @param block The tool use block that was rejected
     * @param reason Human-readable explanation of why the tool was rejected
     */
    private createToolRejectionMessage(block: ToolUse, reason: string): void {
        this.taskState.userMessageContent.push({
            type: "text",
            text: `${reason} ${ToolDisplayUtils.getToolDescription(block, this.coordinator)}`,
        })
    }

    /**
     * Adds hook context modification to the conversation if provided.
     * Parses the context to extract type prefix and formats as XML.
     *
     * @param contextModification The context string from the hook output
     * @param source The hook source name ("PreToolUse" or "PostToolUse")
     */
    private addHookContextToConversation(contextModification: string | undefined, source: string): void {
        if (!contextModification) {
            return
        }

        const contextText = contextModification.trim()
        if (!contextText) {
            return
        }

        // Extract context type from first line if specified (e.g., "WORKSPACE_RULES: ...")
        const lines = contextText.split("\n")
        const firstLine = lines[0]
        let contextType = "general"
        let content = contextText

        // Check if first line specifies a type: "TYPE: content"
        const typeMatchRegex = /^([A-Z_]+):\s*(.*)/
        const typeMatch = typeMatchRegex.exec(firstLine)
        if (typeMatch) {
            contextType = typeMatch[1].toLowerCase()
            const remainingLines = lines.slice(1).filter((l: string) => l.trim())
            content = typeMatch[2] ? [typeMatch[2], ...remainingLines].join("\n") : remainingLines.join("\n")
        }

        const hookContextBlock = {
            type: "text" as const,
            text: `<hook_context source="${source}" type="${contextType}">\n${content}\n</hook_context>`,
        }

        this.taskState.userMessageContent.push(hookContextBlock)
    }

    private async runPostToolUseHook(
        block: ToolUse,
        toolResult: any,
        executionSuccess: boolean,
        executionStartTime: number,
        hooksEnabled: boolean,
    ): Promise<boolean> {
        const { executeHook } = await import("../hooks/hook-executor")

        const executionTimeMs = Date.now() - executionStartTime

        const postToolResult = await executeHook({
            hookName: "PostToolUse",
            hookInput: {
                postToolUse: {
                    toolName: block.name,
                    parameters: block.params,
                    result: typeof toolResult === "string" ? toolResult : JSON.stringify(toolResult),
                    success: executionSuccess,
                    executionTimeMs,
                },
            },
            isCancellable: true,
            messenger: this.taskMessenger,

            setActiveHookExecution: this.setActiveHookExecution,
            clearActiveHookExecution: this.clearActiveHookExecution,
            messageStateHandler: this.messageStateHandler,
            taskId: this.taskId,
            hooksEnabled,
            model: getHookModelContext(this.api, this.stateManager),
            toolName: block.name,
        })

        // Handle cancellation request
        if (postToolResult.cancel === true) {
            const errorMessage = postToolResult.errorMessage || "Hook requested task cancellation"
            const card = await this.taskMessenger.createCard({
                header: "Hook Error",
                body: errorMessage,
                status: CardStatus.ERROR,
            })
            await card.finalize(CardStatus.ERROR)
            return true
        }

        // Add context modification to the conversation if provided
        if (postToolResult.contextModification) {
            this.addHookContextToConversation(postToolResult.contextModification, "PostToolUse")
        }

        return false
    }

    /**
     * Handle partial block streaming UI updates.
     *
     * During streaming API responses, the AI sends partial tool use blocks as they're
     * generated. This method updates the UI to show the tool being constructed in real-time.
     *
     * NOTE: This is ONLY for UI updates. No tool results are pushed to the conversation
     * during partial block handling. The complete block handler will add the final result.
     *
     * @param block The partial tool use block with incomplete parameters
     * @param config The task configuration containing all necessary context
     */
    private async handlePartialBlock(block: ToolUse, config: TaskConfig): Promise<void> {
        // Delegate to coordinator for both modular and legacy handlers
        await this.coordinator.handlePartialBlock(block, config)
    }

    /**
     * Handle complete block execution.
     *
     * This is the main execution flow for a tool:
     * 1. Execute the actual tool (tool handlers now run PreToolUse hooks post-approval)
     * 2. Run PostToolUse hooks (if enabled) - cannot block, only observe
     * 3. Add hook context modifications to the conversation
     * 4. Update focus chain tracking
     *
     * Note: PreToolUse hooks are now executed by individual tool handlers after approval
     * and before the actual tool operation. This provides better UX as approval dialogs
     * appear immediately without hook execution delay.
     *
     * PostToolUse hooks are for observation/logging only and cannot block.
     *
     * @param block The complete tool use block with all parameters
     * @param config The task configuration containing all necessary context
     */
    private async handleCompleteBlock(block: ToolUse, config: any): Promise<void> {
        // Check abort flag at the very start to prevent execution after cancellation
        if (this.taskState.abort) {
            return
        }

        const hooksEnabled = getHooksEnabledSafe(this.stateManager.getGlobalSettingsKey("hooksEnabled"))

        // Track if we need to cancel after hooks complete
        let shouldCancelAfterHook = false

        let executionSuccess = true
        let toolResult: any = null
        let toolWasExecuted = false
        const executionStartTime = Date.now()

        try {
            // Final abort check immediately before tool execution
            if (this.taskState.abort) {
                return
            }

            // Execute the actual tool
            toolResult = await this.coordinator.execute(config, block)
            toolWasExecuted = true

            // Increment tool call count and inject warning if needed
            const count = ++this.taskState.totalToolCallCount
            if (count >= 50 && (count - 50) % 25 === 0) {
                const warning = `

[SYSTEM NOTE: You have executed ${count} tool calls in this task. Please ensure you are not in an infinite loop and are making progress towards the goal. If you have completed the task, please call attempt_completion. If you are stuck, consider a different approach.]`
                if (typeof toolResult === "string") {
                    toolResult += warning
                } else if (Array.isArray(toolResult)) {
                    const lastBlock = toolResult[toolResult.length - 1]
                    if (lastBlock && lastBlock.type === "text") {
                        lastBlock.text += warning
                    } else {
                        toolResult.push({ type: "text", text: warning } as any)
                    }
                }
            }
            if (!this.taskState.didAttemptCompletion) {
                this.pushToolResult(toolResult, block)
            }

            // Check abort before running PostToolUse hook (success path)
            if (this.taskState.abort) {
                return
            }

            // Run PostToolUse hook for successful tool execution
            // Skip for attempt_completion since it marks task completion, not actual work
            if (hooksEnabled && block.name !== "attempt_completion") {
                const hookRequestedCancel = await this.runPostToolUseHook(
                    block,
                    toolResult,
                    executionSuccess,
                    executionStartTime,
                    hooksEnabled, // always true here - already checked by caller
                )
                if (hookRequestedCancel) {
                    await config.callbacks.cancelTask()
                    shouldCancelAfterHook = true
                }
            }
        } catch (error) {
            executionSuccess = false
            toolResult = formatResponse.toolError(`Tool execution failed: ${error}`)

            // Check abort before running PostToolUse hook (error path)
            if (this.taskState.abort) {
                throw error
            }

            // Run PostToolUse hook for failed tool execution
            // Skip for attempt_completion since it marks task completion, not actual work
            if (toolWasExecuted && hooksEnabled && block.name !== "attempt_completion") {
                const hookRequestedCancel = await this.runPostToolUseHook(
                    block,
                    toolResult,
                    executionSuccess,
                    executionStartTime,
                    hooksEnabled, // always true here - already checked by caller
                )
                if (hookRequestedCancel) {
                    await config.callbacks.cancelTask()
                    shouldCancelAfterHook = true
                }
            }

            // Re-throw the error after PostToolUse completes
            throw error
        }

        // Early return if hook requested cancellation
        if (shouldCancelAfterHook) {
            return
        }
    }
}
