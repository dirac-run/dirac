import { getHookModelContext } from "@core/hooks/hook-model-context"
import { getHooksEnabledSafe } from "@core/hooks/hooks-utils"
import { executePreCompactHookWithCleanup, HookCancellationError } from "@core/hooks/precompact-executor"
import { summarizeTask } from "@core/prompts/contextManagement"
import { isMultiRootEnabled } from "@core/workspace/multi-root-utils"
import { formatContentBlockToMarkdown } from "@integrations/misc/export-markdown"
import { telemetryService } from "@services/telemetry"
import { findLastIndex } from "@shared/array"
import { CardStatus, DiracMessageType, Mode } from "@shared/ExtensionMessage"
import { DiracContent, DiracStorageMessage } from "@shared/messages/content"
import { Logger } from "@shared/services/Logger"
import { ApiConversationManagerDependencies } from "./types/api-conversation-manager"

export class ApiConversationManager {
    constructor(private dependencies: ApiConversationManagerDependencies) { }

    public calculatePreCompactDeletedRange(apiConversationHistory: DiracStorageMessage[]): [number, number] {
        const newDeletedRange = this.dependencies.contextManager.getNextTruncationRange(
            apiConversationHistory,
            this.dependencies.taskState.conversationHistoryDeletedRange,
            "quarter", // Force aggressive truncation on error
        )

        return newDeletedRange || [0, 0]
    }

    public async handleContextWindowExceededError(): Promise<void> {
        const apiConversationHistory = this.dependencies.messageStateHandler.getApiConversationHistory()

        // Run PreCompact hook before truncation
        const hooksEnabled = getHooksEnabledSafe(this.dependencies.stateManager.getGlobalSettingsKey("hooksEnabled"))
        if (hooksEnabled) {
            try {
                // Calculate what the new deleted range will be
                const deletedRange = this.calculatePreCompactDeletedRange(apiConversationHistory)

                // Execute hook - throws HookCancellationError if cancelled
                await executePreCompactHookWithCleanup({
                    taskId: this.dependencies.taskId,
                    ulid: this.dependencies.ulid,
                    modelContext: getHookModelContext(this.dependencies.api, this.dependencies.stateManager),
                    apiConversationHistory,
                    conversationHistoryDeletedRange: this.dependencies.taskState.conversationHistoryDeletedRange,
                    contextManager: this.dependencies.contextManager,
                    diracMessages: this.dependencies.messageStateHandler.getDiracMessages(),
                    messageStateHandler: this.dependencies.messageStateHandler,
                    compactionStrategy: "standard-truncation-lastquarter",
                    deletedRange,
                    messenger: this.dependencies.taskMessenger,
                    setActiveHookExecution: this.dependencies.setActiveHookExecution.bind(this.dependencies),
                    clearActiveHookExecution: this.dependencies.clearActiveHookExecution.bind(this.dependencies),
                    postStateToWebview: this.dependencies.postStateToWebview.bind(this.dependencies),
                    taskState: this.dependencies.taskState,
                    cancelTask: this.dependencies.cancelTask.bind(this.dependencies),
                    hooksEnabled,
                })
            } catch (error) {
                // If hook was cancelled, re-throw to stop compaction
                if (error instanceof HookCancellationError) {
                    throw error
                }

                // Graceful degradation: Log error but continue with truncation
                Logger.error("[PreCompact] Hook execution failed:", error)
            }
        }

        // Proceed with standard truncation
        const newDeletedRange = this.dependencies.contextManager.getNextTruncationRange(
            apiConversationHistory,
            this.dependencies.taskState.conversationHistoryDeletedRange,
            "quarter", // Force aggressive truncation
        )

        this.dependencies.taskState.conversationHistoryDeletedRange = newDeletedRange

        await this.dependencies.messageStateHandler.saveDiracMessagesAndUpdateHistory()

    }

    public async determineContextCompaction(previousApiReqIndex: number): Promise<boolean> {
        let shouldCompact = false
        const useAutoCondense = this.dependencies.stateManager.getGlobalSettingsKey("useAutoCondense")
        const autoCondenseThreshold = useAutoCondense ? 0.75 : undefined

        if (useAutoCondense) {
            if (this.dependencies.taskState.currentlySummarizing) {
                this.dependencies.taskState.currentlySummarizing = false
            } else {
                shouldCompact = this.dependencies.contextManager.shouldCompactContextWindow(
                    this.dependencies.messageStateHandler.getDiracMessages(),
                    this.dependencies.api,
                    previousApiReqIndex,
                    autoCondenseThreshold,
                )

                // Edge case: summarize_task tool call completes but user cancels next request before it finishes.
                // This results in currentlySummarizing being false, and we fail to update the context window token estimate.
                // Check active message count to avoid summarizing a summary (bad UX but doesn't break logic).
                if (shouldCompact && this.dependencies.taskState.conversationHistoryDeletedRange) {
                    const apiHistory = this.dependencies.messageStateHandler.getApiConversationHistory()
                    const activeMessageCount =
                        apiHistory.length - this.dependencies.taskState.conversationHistoryDeletedRange[1] - 1

                    // IMPORTANT: We haven't appended the next user message yet, so the last message is an assistant message.
                    // That's why we compare to even numbers (0, 2) rather than odd (1, 3).
                    if (activeMessageCount <= 2) {
                        shouldCompact = false
                    }
                }
            }
        }

        return shouldCompact
    }

    public async prepareApiRequest(params: {
        userContent: DiracContent[]
        shouldCompact: boolean
        includeFileDetails: boolean
        useCompactPrompt: boolean
        previousApiReqIndex: number
        directResponseText?: string
        popover?: boolean
        isFirstRequest: boolean
        providerId: string
        modelId: string
        mode: string
    }): Promise<{ userContent: DiracContent[]; lastApiReqIndex: number; isDirectResponse?: boolean; directResponseText?: string }> {
        let nextUserContent = params.userContent

        // 1. Run User Prompt Submit Hook
        const hookResult = await this.dependencies.runUserPromptSubmitHook(nextUserContent, params.isFirstRequest ? "initial_task" : "feedback")
        if (hookResult.cancel) {
            return {
                userContent: nextUserContent,
                lastApiReqIndex: params.previousApiReqIndex,
                isDirectResponse: true,
                directResponseText: hookResult.errorMessage,
            }
        }

        let parsedUserContent: DiracContent[]
        let environmentDetails: string
        let diracrulesError: boolean
        let isDirectResponse = false
        let directResponseText = params.directResponseText

        if (params.shouldCompact) {
            // When compacting, skip full context loading (use summarize_task instead)
            parsedUserContent = params.userContent
            environmentDetails = ""
            diracrulesError = false
            this.dependencies.taskState.lastAutoCompactTriggerIndex = params.previousApiReqIndex
        } else {
            // When NOT compacting, load full context with mentions parsing and slash commands
            const [
                parsedUserContentResult,
                environmentDetailsResult,
                diracrulesErrorResult,
                availableSkillsResult,
                isDirectResponseResult,
                directResponseTextResult,
            ] = await this.dependencies.loadContext(
                nextUserContent,
                params.includeFileDetails,
                params.useCompactPrompt,
            )
            parsedUserContent = parsedUserContentResult
            environmentDetails = environmentDetailsResult
            diracrulesError = diracrulesErrorResult
            isDirectResponse = isDirectResponseResult
            directResponseText = directResponseTextResult
            this.dependencies.taskState.availableSkills = availableSkillsResult
        }

        this.dependencies.taskState.didSwitchToActMode = false // Reset after use

        if (isDirectResponse && directResponseText) {
            return { userContent: [{ type: "text", text: directResponseText }], lastApiReqIndex: -1, isDirectResponse: true, directResponseText }
        }

        // error handling if the user uses the /newrule command & their .diracrules is a file, for file read operations didnt work properly
        if (diracrulesError === true) {
            const card = await this.dependencies.taskMessenger.createCard({
                header: "Rule Error",
                body: "Issue with processing the /newrule command. Double check that, if '.diracrules' already exists, it's a directory and not a file. Otherwise there was an issue referencing this file/directory.",
                status: CardStatus.ERROR,
            })
            await card.finalize(CardStatus.ERROR)
        }

        // Replace userContent with parsed content that includes file details and command instructions.
        const userContent = parsedUserContent

        // add environment details as its own text block, separate from tool results
        // do not add environment details to the message which we are compacting the context window
        if (environmentDetails) {
            userContent.push({ type: "text", text: environmentDetails })
        }

        if (params.shouldCompact) {
            userContent.push({
                type: "text",
                text: summarizeTask(
                    this.dependencies.cwd,
                    isMultiRootEnabled(this.dependencies.stateManager),
                ),
            })
        }

        // getting verbose details is an expensive operation, it uses globby to top-down build file structure of project which for large projects can take a few seconds
        // for the best UX we show a placeholder api_req_started message with a loading spinner as this happens
        const apiReqId = `api-req-${Date.now()}`
        await this.dependencies.taskMessenger.upsertApiStatus({
            id: apiReqId,
            request: userContent.map((block) => formatContentBlockToMarkdown(block)).join("\n\n") + "\n\nLoading...",
        })

        await this.dependencies.messageStateHandler.addToApiConversationHistory({
            role: "user",
            content: userContent,
            ts: Date.now(),
        })

        telemetryService.captureConversationTurnEvent(
            this.dependencies.ulid,
            params.providerId,
            params.modelId,
            "user",
            params.mode as Mode,
            undefined,
            this.dependencies.taskState.useNativeToolCalls,
        )

        // Capture task initialization timing telemetry for the first API request
        if (params.isFirstRequest) {
            const durationMs = Math.round(performance.now() - this.dependencies.taskInitializationStartTime)
            telemetryService.captureTaskInitialization(
                this.dependencies.ulid,
                this.dependencies.taskId,
                durationMs,
                this.dependencies.stateManager.getGlobalSettingsKey("enableCheckpointsSetting"),
            )
        }

        // since we sent off a placeholder api_req_started message to update the webview while waiting to actually start the API request (to load potential details for example), we need to update the text of that message
        const diracMessages = this.dependencies.messageStateHandler.getDiracMessages()
        const lastApiReqIndex = findLastIndex(
            diracMessages,
            (m) => m.id === apiReqId,
        )

        if (lastApiReqIndex !== -1) {
            const msg = diracMessages[lastApiReqIndex]
            if (msg.content.type === "api_status") {
                await this.dependencies.messageStateHandler.updateDiracMessage(lastApiReqIndex, {
                    content: {
                        type: DiracMessageType.API_STATUS,
                        status: {
                            ...msg.content.status,
                            request: userContent.map((block) => formatContentBlockToMarkdown(block)).join("\n\n"),
                        },
                    },
                })
            }
        }

        await this.dependencies.postStateToWebview()

        return { userContent, lastApiReqIndex, directResponseText }
    }

}
