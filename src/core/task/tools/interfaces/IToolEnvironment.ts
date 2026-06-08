import { CardStatus, Card, RenderType, ActionButton, CleanupStrategy } from "../../../../shared/ExtensionMessage"
import { FileDiagnostics } from "@shared/proto/index.dirac"
import { SymbolRange } from "@utils/ASTAnchorBridge"
import { SymbolLocation } from "@services/symbol-index/SymbolIndexService"

import { DiracMessage } from "../../../../shared/ExtensionMessage"
import { SubagentProgressUpdate, SubagentRunResult } from "../subagent/SubagentRunner"
import { HookExecutionResult } from "../../../hooks/hook-executor"
import { TaskState } from "../../TaskState"

import { BrowserActionResult } from "../../../../shared/ExtensionMessage"
import { SkillContent, SkillMetadata } from "../../../../shared/skills"
import { FileInfo } from "../../../../services/glob/list-files"
import { DiracAskResponse } from "../../../../shared/WebviewMessage"
import { IDiracContext } from "./IDiracContext"
import { TaskConfig } from "../types/TaskConfig"

export interface ICardHandle {
    readonly collapsed: boolean
    readonly id: string
    readonly header: string
    readonly icon?: string
    readonly renderType: RenderType
    readonly body?: string
    readonly requireApproval?: boolean
    readonly requireFeedback?: boolean
    readonly feedbackPlaceholder?: string
    readonly actions?: ActionButton[]
    readonly maxHeight?: number
    readonly cleanupStrategy?: CleanupStrategy
    readonly status: CardStatus

    /**
     * Update the card's metadata or state.
     */
    update(patch: Partial<Omit<Card, "id">>): Promise<void>

    /**
     * Blocks until the user interacts with the card (approval, feedback, or custom action).
     * Returns the action value (e.g., 'approve', 'reject', 'submit', or custom button value).
     */
    waitForInteraction(): Promise<{
        action: DiracAskResponse | string
        response: DiracAskResponse
        value?: string
        text?: string
        images?: string[]
        files?: string[]
        userEdits?: Record<string, string>
    }>

    /**
     * Append text to the existing body.
     * Optimized for streaming stdout/logs.
     */
    appendBody(chunk: string): Promise<void>

    /**
     * Transitions the card to a final state and resolves any pending interaction.
     */
    finalize(status: CardStatus, doNotAutoCollapse?: boolean): Promise<void>
}

export interface CardParams {
    header: string
    icon?: string
    status?: CardStatus
    renderType?: RenderType
    body?: string
    requireApproval?: boolean
    requireFeedback?: boolean
    feedbackPlaceholder?: string
    actions?: ActionButton[]
    collapsed?: boolean
    maxHeight?: number
    cleanupStrategy?: CleanupStrategy
    do_not_auto_collapse?: boolean
    outcome?: string
}

export interface IUITrait {
    /**
     * Creates a card for tracking execution progress.
     * This card is purely for observability.
     */
    createCard(params: CardParams): Promise<ICardHandle>

    /**
     * Generic upsert for informational messages.
     */
    upsertText(text: string, isReasoning?: boolean, role?: "user" | "assistant"): Promise<void>

    /**
     * Creates a text stream for real-time feedback.
     */
    streamText(type: "markdown" | "reasoning"): Promise<import("../../../../shared/ExtensionMessage").ITextStreamHandle>
}

export interface IInteractionTrait {
    /**
     * Triggers a transient permission request.
     * The UI for this request is separate from any execution cards.
     */
    askPermission(message: string): Promise<{ approved: boolean; action: string; value?: string; text?: string; images?: string[]; files?: string[]; userEdits?: Record<string, string>; card: ICardHandle }>

    /**
     * Generic ask for followup, plan_mode, new_task, condense, etc.
     */
}

export interface ITelemetryTrait {
    /**
     * Captures custom tool usage telemetry.
     * Standard telemetry (invocation, duration, success) is handled automatically by the coordinator.
     */
    captureCustomMetadata(metadata: Record<string, any>): void
}

export interface ISystemTrait {
    /**
     * Executes a shell command.
     */
    executeCommand(
        command: string,
        options?: { timeout?: number; onOutput?: (chunk: string) => void },
    ): Promise<[boolean, any]>

    /**
     * Performs a regex search across files.
     */
    searchFiles(
        directoryPath: string,
        regex: string,
        options?: {
            filePattern?: string
            contextLines?: number
            excludeFilePatterns?: string[]
            debugLog?: (info: Record<string, any>) => Promise<void>
        },
    ): Promise<string>

    /**
     * Returns system information for bug reporting.
     */
    getSystemInfo(): Promise<{
        operatingSystem: string
        diracVersion: string
        hostInfo: string
        systemInfo: string
        providerAndModel: string
    }>

    /**
     * Opens a URL in the user's default browser.
     */
    openUrl(url: string): Promise<void>
}

export interface IBrowserTrait {
    launch(url: string): Promise<BrowserActionResult>
    click(coordinate: string): Promise<BrowserActionResult>
    type(text: string): Promise<BrowserActionResult>
    scroll(direction: "up" | "down"): Promise<BrowserActionResult>
    close(): Promise<BrowserActionResult>
}

export interface ISkillsTrait {
    getAvailableSkills(): Promise<SkillMetadata[]>
    getSkillContent(name: string, availableSkills: SkillMetadata[]): Promise<SkillContent | undefined>
    listSupportingFiles(path: string): Promise<{ docs: string[]; scripts: string[] }>
}

export interface IWorkspaceTrait {
    /**
     * Resolves a relative path or a path with workspace hints into absolute and displayable formats.
     * @param relPath The path to resolve (e.g., "src/main.ts" or "@frontend:src/index.ts").
     */
    resolvePath(path: string): Promise<{ absolutePath: string; displayPath: string }>
    /**
     * Lists files in the specified directory.
     */
    listFiles(path: string, recursive: boolean, limit: number): Promise<[FileInfo[], boolean]>
    /**
     * Reads the content of a file.
     */
    readFile(path: string): Promise<string>
    /**
     * Reads the content of a file, handling rich formats (PDF, DOCX, images).
     */
    readRichFile(path: string): Promise<{ text: string; imageBlock?: any }>
    /**
     * Returns information about a file (size, existence, etc.).
     */
    getFileInfo(path: string): Promise<{ size: number; isFile: boolean; exists: boolean }>

    /**
     * Writes content to a file.
     */
    writeFile(path: string, content: string): Promise<void>
    /**
     * Saves the document if it has unsaved changes.
     */
    saveOpenDocumentIfDirty(options: { filePath: string }): Promise<void>
}

export interface SaveResult {
    content: string
    userEdits: boolean
    autoFormatting: boolean
}

export interface IEditorTrait {
    /** Opens the diff/review UI for one or more files */
    showReview(files: { absolutePath: string; displayPath: string; content: string; originalContent?: string }[]): Promise<void>
    /** Hides the review UI */
    hideReview(): Promise<void>
    /** Opens a specific file in the editor */
    open(path: string, options?: { displayPath?: string }): Promise<void>
    /** Updates the content of the currently open editor */
    update(content: string, finalize: boolean): Promise<void>
    /** Saves changes in the current editor, returning auto-formatting and user edits */
    saveChanges(options?: { skipDiagnostics?: boolean }): Promise<SaveResult>
    /** Applies content and saves a file silently (background edit) */
    applyAndSaveSilently(path: string, content: string): Promise<SaveResult>
    /** Applies content and saves multiple files silently in a single transaction */
    applyAndSaveBatchSilently(files: { path: string; content: string }[]): Promise<Map<string, SaveResult>>
    /** Reverts all unsaved changes in the editor */
    revertChanges(): Promise<void>
    /** Resets the editor state */
    reset(): Promise<void>
    /** Scrolls the editor to the first detected difference */
    scrollToFirstDiff(): Promise<void>
    /** Undoes the last set of user edits in the diff view */
    undoUserEdits(): Promise<void>
    /** Formats a file using the editor's configured formatter and returns the formatted content */
    format(path: string): Promise<string>
}

export interface ISymbolTrait {
    /** Returns the character range of a symbol in a file */
    getSymbolRange(path: string, symbol: string, type?: string): Promise<SymbolRange | undefined>
    /** Returns all definitions of a symbol in the project */
    getDefinitions(symbol: string): Promise<SymbolLocation[]>
    /** Returns all references to a symbol in the project */
    getReferences(symbol: string): Promise<SymbolLocation[]>
    /** Returns all occurrences (defs + refs) of a symbol */
    getSymbols(symbol: string): Promise<SymbolLocation[]>
    /** Forces an index update for a specific file */
    updateIndex(path: string): Promise<void>
    /** Initializes the symbol index for a project root */
    initializeIndex(root: string): Promise<void>
}

export interface IOrchestrationTrait {
    runSubagent(
        prompt: string,
        options?: {
            subagentName?: string
            timeout?: number
            maxTurns?: number
            includeHistory?: boolean
            onUpdate?: (update: SubagentProgressUpdate) => void
        },
    ): Promise<SubagentRunResult>

    /**
     * Executes a lifecycle hook.
     */
    runHook(name: string, input: any, options?: { isCancellable?: boolean }): Promise<HookExecutionResult>

    /**
     * Transitions the agent from Plan Mode to Act Mode.
     */
    switchToActMode(): Promise<boolean>

    /**
     * Saves a checkpoint of the current task state.
     */
    saveCheckpoint(isTaskComplete?: boolean, messageId?: string): Promise<void>

    /**
     * Returns the conversation history.
     */
    getHistory(): DiracMessage[]

    /**
     * Updates the conversation history truncation range.
     */
    setTruncationRange(range: [number, number]): void

    /**
     * Calculates the next truncation range based on a strategy.
     */
    getNextTruncationRange(strategy: "none" | "half" | "quarter" | "lastTwo"): [number, number]
    updateMessage(index: number, updates: Partial<DiracMessage>): Promise<void>

    /**
     * Returns the current runtime task state.
     */
    getTaskState<T extends keyof TaskState>(key: T): TaskState[T]

    /**
     * Updates the runtime task state.
     */
    setTaskState<T extends keyof TaskState>(key: T, value: TaskState[T]): void

    /**
     * Checks if the latest task completion has new changes.
     */
    doesLatestTaskCompletionHaveNewChanges(): Promise<boolean>

    resetTransientState(): Promise<void>
}

export interface IASTTrait {
    /**
     * Returns a skeleton of the file (classes, functions, etc.) with stable hash anchors.
     */
    getSkeleton(path: string, options?: { showCallGraph?: boolean }): Promise<string>

    /**
     * Returns specific functions from a file with stable hash anchors.
     */
    getFunctions(
        absolutePath: string,
        relPath: string,
        functionNames: string[],
    ): Promise<{ formattedContent: string; foundNames: string[] } | null>
}

export interface IDiagnosticsTrait {
    /**
     * Prepares diagnostics for the specified files.
     */
    prepare(paths: string[]): Promise<void>

    /**
     * Returns raw diagnostics for the specified files.
     */
    getRaw(paths: string[]): Promise<FileDiagnostics[]>
}

export interface ILoggingTrait {
    error(message: string, ...args: any[]): void
    warn(message: string, ...args: any[]): void
    info(message: string, ...args: any[]): void
    debug(message: string, ...args: any[]): void
    log(message: string, ...args: any[]): void
    trace(message: string, ...args: any[]): void
}


/**
 * The Tool Environment provides access to all capabilities (traits)
 * available to a modular tool during its execution.
 */
export interface IToolEnvironment {
    readonly telemetry: ITelemetryTrait
    readonly ui: IUITrait
    readonly interaction: IInteractionTrait
    readonly system: ISystemTrait
    readonly workspace: IWorkspaceTrait
    readonly ast: IASTTrait
    readonly diagnostics: IDiagnosticsTrait

    readonly editor: IEditorTrait
    readonly symbol: ISymbolTrait

    readonly browser: IBrowserTrait
    readonly skills: ISkillsTrait
    readonly orchestration: IOrchestrationTrait

    /** Persistent state management */
    readonly context: IDiracContext

    /** The name of the tool being executed */
    readonly toolName: string

    /** Task and environment configuration */
    readonly config: TaskConfig

    /** Structured logging access for tools */
    readonly logging: ILoggingTrait

}
