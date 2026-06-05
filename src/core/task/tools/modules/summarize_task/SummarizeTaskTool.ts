import { IDiracTool } from "../../interfaces/IDiracTool"
import { StronglyTypedUIHelpers } from "../../types/UIHelpers"
import { ToolUse } from "@core/assistant-message"
import { StateManager } from "@core/storage/StateManager"
import { telemetryService } from "@/services/telemetry"
import { IToolEnvironment } from "../../interfaces/IToolEnvironment"
import { DiracToolSpec, DiracDefaultTool } from "@/shared/tools"
import { formatResponse } from "@core/prompts/responses"
import { continuationPrompt } from "@core/prompts/contextManagement"
import { CardStatus } from "@shared/ExtensionMessage"
import { DiracIcon } from "@/shared/icons"
import { stripHashes } from "../../../../../shared/utils/line-hashing"

export const summarize_task_spec: DiracToolSpec = {
    id: DiracDefaultTool.SUMMARIZE_TASK,
    name: "summarize_task",
    description: "Summarize the task to free up context window space.",
    parameters: [
        {
            name: "context",
            required: true,
            instruction:
                "Detailed summary of the conversation so far, including current work, technical concepts, modified files, problems solved, and exact pending next steps.",
        },
        {
            name: "required_files",
            required: false,
            type: "array",
            items: { type: "string" },
            instruction: "List of relative paths to the most important files needed to continue the task.",
        },
    ],
}


export class SummarizeTaskTool implements IDiracTool {
    spec(): DiracToolSpec {
        return summarize_task_spec
    }

    supportedSurfaces() {
        return ["all" as const]
    }

    async processCall(args: any, env: IToolEnvironment): Promise<any> {
        const { context, required_files: requiredFiles } = args

        if (!context) {
            env.orchestration.setTaskState("consecutiveMistakeCount", env.orchestration.getTaskState("consecutiveMistakeCount") + 1)
            return formatResponse.toolError("Missing required parameter: context")
        }

        env.orchestration.setTaskState("consecutiveMistakeCount", 0)

        const hookResult = await this.runPreCompactHook(env)
        if (hookResult.cancel) {
            return formatResponse.toolError("Context compaction was cancelled by PreCompact hook.")
        }

        await this.displaySummaryCard(context, env)

        const fileContents = await this.readRequiredFiles(context, requiredFiles, env)

        let toolResultContent = continuationPrompt(context) + fileContents
        if (hookResult.contextModification) {
            toolResultContent += `\n\n[Context Modification from PreCompact Hook]\n${hookResult.contextModification}`
        }

        await this.finalizeTaskState(env)
        this.captureTelemetry(env)

        return formatResponse.toolResult(toolResultContent)
    }

    private async runPreCompactHook(env: IToolEnvironment) {
        const useAutoCondense = StateManager.get().getGlobalSettingsKey("useAutoCondense")
        const strategy = useAutoCondense ? "auto-condense" : "standard-truncation-firstpair"

        const telemetryData = env.config.services.contextManager.getContextTelemetryData(
            env.config.messageState.getDiracMessages(),
            env.config.api,
            env.config.taskState.lastAutoCompactTriggerIndex,
        )

        return await env.orchestration.runHook(
            "PreCompact",
            {
                ulid: env.config.ulid,
                contextSize: telemetryData?.tokensUsed ?? 0,
                compactionStrategy: strategy,
                tokensIn: telemetryData?.tokensUsed ?? 0,
                tokensOut: 0,
                tokensInCache: 0,
                tokensOutCache: 0,
                deletedRangeStart: env.config.taskState.conversationHistoryDeletedRange?.[0] ?? 0,
                deletedRangeEnd: env.config.taskState.conversationHistoryDeletedRange?.[1] ?? 0,
            },
            { isCancellable: true },
        )
    }

    private async displaySummaryCard(context: string, env: IToolEnvironment): Promise<void> {
        if (env.config.isSubagentExecution) return;
        const card = !env.config.isSubagentExecution
            ? await env.ui.createCard({
                header: "Summarize Task",
                status: CardStatus.RUNNING,
                icon: DiracIcon.SUMMARIZE,
                collapsed: true,
            })
            : undefined
        if (card) {
            await card.update({
                header: "Task Summary",
                status: CardStatus.SUCCESS,
                body: stripHashes(context),
                renderType: "markdown",
            })
            await card.finalize(CardStatus.SUCCESS)
        }
    }

    private async readRequiredFiles(context: string, requiredFiles: string[] | undefined, env: IToolEnvironment): Promise<string> {
        let fileContents = ""
        const loadedFilePaths: string[] = []
        const filePaths: string[] = requiredFiles || []

        if (!requiredFiles) {
            const filePathRegex = /9\.\s*(?:Optional\s+)?Required Files:\s*((?:\n\s*-\s*.+)+)/m
            const match = context.match(filePathRegex)
            if (match) {
                const lines = match[1].split("\n")
                for (const line of lines) {
                    const pathMatch = line.match(/^\s*-\s*(.+)$/)
                    if (pathMatch) {
                        filePaths.push(pathMatch[1].trim())
                    }
                }
            }
        }

        if (filePaths.length > 0) {
            const MAX_FILES_LOADED = 8
            const MAX_CHARS = 100_000
            let filesLoaded = 0
            let totalChars = 0

            for (const relPath of filePaths) {
                try {
                    if (!env.config.services.diracIgnoreController.validateAccess(relPath)) {
                        continue
                    }

                    if (!(await env.config.callbacks.shouldAutoApproveToolWithPath(DiracDefaultTool.FILE_READ, relPath))) {
                        continue
                    }

                    const { absolutePath, displayPath } = await env.workspace.resolvePath(relPath)
                    const { text: content } = await env.workspace.readRichFile(absolutePath)

                    if (totalChars + content.length > MAX_CHARS) break

                    await env.config.services.fileContextTracker.trackFileContext(relPath, "file_mentioned")

                    fileContents += `\n\n<file_content path="${displayPath}">\n${content}\n</file_content>`
                    loadedFilePaths.push(displayPath)
                    totalChars += content.length
                    filesLoaded++

                    if (filesLoaded >= MAX_FILES_LOADED) break
                } catch (error) {
                    // Skip failed reads
                }
            }
        }

        if (fileContents) {
            const fileMentionString = loadedFilePaths.map((path) => `'${path}'`).join(", ") + " (see below for file content)"
            fileContents = `\n\nThe following files were automatically read based on the files listed in the Required Files section: ${fileMentionString}. These are the latest versions of these files - you should reference them directly and not re-read them:${fileContents}`
        }

        return fileContents
    }

    private async finalizeTaskState(env: IToolEnvironment): Promise<void> {
        const range = env.orchestration.getNextTruncationRange("lastTwo")
        env.orchestration.setTruncationRange(range)
        env.orchestration.setTaskState("currentlySummarizing", true)
        await env.config.messageState.saveDiracMessagesAndUpdateHistory()
    }

    private captureTelemetry(env: IToolEnvironment): void {
        const telemetryData = env.config.services.contextManager.getContextTelemetryData(
            env.config.messageState.getDiracMessages(),
            env.config.api,
            env.config.taskState.lastAutoCompactTriggerIndex,
        )

        if (telemetryData) {
            const apiConfig = env.config.services.stateManager.getApiConfiguration()
            const provider = (env.config.mode === "plan" ? apiConfig.planModeApiProvider : apiConfig.actModeApiProvider) as string

            telemetryService.captureSummarizeTask(
                env.config.ulid,
                env.config.api.getModel().id,
                provider,
                telemetryData.tokensUsed,
                telemetryData.maxContextWindow,
            )
        }
    }
    async handlePartialBlock(block: ToolUse, uiHelpers: StronglyTypedUIHelpers): Promise<void> {
        const context = block.params.context || ""

        if (!context) {
            return
        }

        // Show streaming summary generation in tool UI
        // Partial updates for summarize_task are handled by the BUILDING state in the UI
        // No need for manual say() calls here anymore as the dispatcher handles the "Building..." state.
    }

}
