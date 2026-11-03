import type { TaskletRecord } from "@core/storage/taskStorage"
import type { TaskInteractionRequest } from "../../types/task-messenger"
import type { CardParams, ICardHandle } from "./ICardHandle"
import type { IArchitectureTrait } from "./IArchitectureTrait"
import type { TextCondensationTemplateId } from "@core/text-condensation/TextCondenser"
import type {
	AstImplementationRequest,
	AstImplementationResult,
	AstOccurrenceRequest,
	AstOccurrenceResult,
	AstOutlineRequest,
	AstOutlineResult,
	AstRenameRequest,
	AstReplacementRequest,
	SourceMutationPlan,
} from "@services/source-ast/types"
import type { GoalChildRecord, GoalChildRole, GoalChildStatus, GoalObjectiveRevision, GoalTaskSummary } from "@shared/goal"
import type { TranscriptPage } from "@shared/messages/content"
import { FileDiagnostics } from "@shared/proto/index.dirac"
import type { ResponseArguments } from "@shared/responseTool"
import type { SubagentIdentity } from "@shared/subagents"
import type { TextFileWindow, TextFileWindowOptions } from "@shared/text-file-window"
import { FileInfo } from "../../../../services/glob/list-files"
import { BrowserActionResult, DiracMessage } from "../../../../shared/ExtensionMessage"
import { SkillContent, SkillMetadata } from "../../../../shared/skills"
import { HookExecutionResult } from "../../../hooks/hook-executor"
import { TaskState, type TaskStateWritableKey } from "../../TaskState"
import { SubagentProgressUpdate, SubagentRunResult } from "../subagent/SubagentRunner"
import { TaskConfig } from "../types/TaskConfig"
import { IDiracContext } from "./IDiracContext"
export type { CardParams, ICardHandle } from "./ICardHandle"
export type { IArchitectureTrait } from "./IArchitectureTrait"

export interface IUITrait {
	/**
	 * Creates a card for tracking execution progress.
	 * This card is purely for observability.
	 */
	createCard(params: CardParams): Promise<ICardHandle>

	/** Creates an interaction that only an explicit user response may resolve. */
	createManualInteractionCard(params: CardParams): Promise<ICardHandle>

	/**
	 * Generic upsert for informational messages.
	 */
	upsertText(text: string, isReasoning?: boolean, role?: "user" | "assistant"): Promise<void>

	/**
	 * Creates a text stream for real-time feedback.
	 */
	streamText(type: "markdown" | "reasoning"): Promise<import("../../../../shared/ExtensionMessage").ITextStreamHandle>

	/** Publishes task state changes to the active UI surface. */
	publishState(): Promise<void>
}

export interface IInteractionTrait {
	/**
	 * Triggers a transient permission request.
	 * The UI for this request is separate from any execution cards.
	 */
	askPermission(
		message: string,
		preview?: PermissionPreview,
	): Promise<{
		approved: boolean
		action: string
		value?: string
		text?: string
		images?: string[]
		files?: string[]
		userEdits?: Record<string, string>
		card: ICardHandle
	}>

	/**
	 * Generic ask for followup, plan_mode, condense, etc.
	 */
}

export interface PermissionPreview {
	utilityEligible?: boolean
	manualOnly?: boolean
	diffs?: import("../../../../shared/ExtensionMessage").CardDiff[]
	rawInput?: import("../../../../shared/ExtensionMessage").CardRawInput
}

export interface ITelemetryTrait {
	/**
	 * Captures custom tool usage telemetry.
	 * Standard telemetry (invocation, duration, success) is handled automatically by the coordinator.
	 */
	captureCustomMetadata(metadata: Record<string, any>): void
	captureTaskCompleted(): void
	captureOptionSelected(optionCount: number, mode: import("@shared/storage/types").Mode): void
	captureOptionsIgnored(optionCount: number, mode: import("@shared/storage/types").Mode): void
}

export interface SystemCommandResult {
	userRejected: boolean
	output: unknown
	completed?: boolean
	exitCode?: number | null
	signal?: NodeJS.Signals | null
	logFilePath?: string
	backgroundCompletion?: Promise<void>
}

export interface ISystemTrait {
	/**
	 * Executes a shell command.
	 */
	executeCommand(command: string, options?: { timeout?: number }): Promise<SystemCommandResult>

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
			includeAnchors?: boolean
			signal?: AbortSignal
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

	/** Shows a native desktop notification when the host supports it. */
	showNotification(options: { title?: string; subtitle?: string; message: string }): void
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
	/** Streams a text range while retaining a complete snapshot only below a caller-supplied line limit. */
	readTextFileWindow(path: string, options: TextFileWindowOptions): Promise<TextFileWindow>
	/** Counts text lines without retaining file content. */
	countTextFileLines(path: string, signal?: AbortSignal): Promise<number>
	/**
	 * Reads the content of a file, handling rich formats (PDF, DOCX, images).
	 */
	readRichFile(path: string): Promise<{ text: string; imageBlock?: any }>
	/** Loads user-attached files into model-facing text. */
	formatAttachedFiles(paths: string[]): Promise<string>
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
	/** Reads authoritative text through the editor's configured transport. */
	readText(path: string): Promise<string>
	/** Opens the diff/review UI for one or more files */
	showReview(files: { absolutePath: string; displayPath: string; content: string; originalContent?: string }[]): Promise<void>
	/** Hides the review UI */
	hideReview(): Promise<void>
	/** Opens a specific file in the editor */
	open(path: string, options?: { displayPath?: string; editType?: "create" | "modify" | "delete" }): Promise<void>
	/** Updates the content of the currently open editor */
	update(content: string, finalize: boolean): Promise<void>
	/** Saves changes in the current editor, returning auto-formatting and user edits */
	saveChanges(options?: { skipDiagnostics?: boolean }): Promise<SaveResult>
	/** Applies content and saves a file silently (background edit) */
	applyAndSaveSilently(path: string, content: string, editType?: "create" | "modify"): Promise<SaveResult>
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

export interface ISourceAstTrait {
	outline(request: AstOutlineRequest): Promise<AstOutlineResult>
	implementations(request: AstImplementationRequest): Promise<AstImplementationResult>
	occurrences(request: AstOccurrenceRequest): Promise<AstOccurrenceResult>
	planRename(request: AstRenameRequest): Promise<SourceMutationPlan>
	planReplacements(request: AstReplacementRequest): Promise<SourceMutationPlan>
	getAnchorFingerprint(path: string): string | null
}

export type TaskletInteractionResult = Awaited<ReturnType<ICardHandle["waitForInteraction"]>>

export interface TaskletInteraction extends TaskInteractionRequest {
	id: string
	status: "pending" | "resolved" | "retired"
	createdAt: number
	retiredAt?: number
	resolvedAt?: number
	resolution?: TaskletInteractionResult
}

export interface TaskletInspection extends TaskletRecord {
	responses: ResponseArguments[]
	interactions: TaskletInteraction[]
	/** Live engine status is informational, never evidence of a committed outcome. */
	executionStatus?: import("@shared/ExtensionMessage").TaskStatus
	backgroundCommandRunning: boolean
	outcomePersisted: boolean
	settlementError?: import("../../TaskRunOutcome").SerializedTaskError
}

export interface TaskletTranscript {
	conversation: import("@shared/messages/content").DiracStorageMessage[]
	presentation: DiracMessage[]
}

export type TaskletInteractionDecision =
	| { operation: "approve" | "reject" | "escalate" }
	| { operation: "answer"; response: TaskletInteractionResult }

export type TaskletResolution = { status: "resolved" | "requires_user_approval" }

export interface TaskletSleepOptions {
	/** Omit to wake for any child communication; [] selects time/user-input only. */
	taskletIds?: string[]
	/** Optional relative deadline in milliseconds (integer, 0..2147483647). */
	timeoutMs?: number
}

export type TaskletWakeResult =
	| { reason: "event"; taskletId: string; eventId: string }
	| { reason: "timeout" | "user_message" | "cancelled" }

/** Parent-only controls. Implementations expose data and operations, never the live Task/host. */
export interface TaskletControls {
	/** Acceptance only: does not wait for or assert successful completion of the assignment. */
	start(input: { title: string; prompt: string }): Promise<TaskletRecord>
	/** Explicit follow-up under the same handle/conversation; returns acceptance, not a result. */
	resume(id: string, message?: string): Promise<TaskletRecord>
	list(): TaskletInspection[]
	inspect(id: string): TaskletInspection
	readTranscript(id: string): Promise<TaskletTranscript>
	/** Queued guidance is not an answer to a pending interaction or proof of consumption. */
	steer(id: string, message: string): Promise<{ id: string; messageId: string; accepted: true }>
	interrupt(id: string, reason?: string): Promise<TaskletInspection>
	resolveInteraction(id: string, requestId: string, decision: TaskletInteractionDecision): Promise<TaskletResolution>
	/** Voluntary wait only; does not consume events/input, join children or start another model loop. */
	sleep(options?: TaskletSleepOptions): Promise<TaskletWakeResult>
}

export interface IOrchestrationTrait {
	/** Available only to an owning ordinary root; never exposes a live Task or host. */
	readonly tasklets?: TaskletControls

	runSubagent(
		prompt: string,
		options?: {
			subagentName?: string
			taskTitle?: string
			agentIdentity?: SubagentIdentity
			timeout?: number
			includeHistory?: boolean
			useUtilityModel?: boolean
			allowedTools?: string[]
			systemSuffix?: string
			onUpdate?: (update: SubagentProgressUpdate) => void | Promise<void>
			/** Abort signal to cancel the subagent run (e.g., parent task cancellation). */
			signal?: AbortSignal
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
	/** Returns false when queued steering supersedes the current completion attempt. */
	commitAttemptCompletion(response: string): Promise<CompletionCommitResult>

	/**
	 * Returns the conversation history.
	 */
	getHistory(): DiracMessage[]
	/** Original delivered user requests since the latest successful completion, independent of API truncation. */
	getCurrentTurnUserRequests(): string[]

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
	 * Updates the runtime task state. Only plain writable fields are accepted:
	 * transition-gated fields are written through their named TaskState
	 * transitions, method keys are not data, and getter-only keys
	 * (abortSignal, lastWaitingCardId) have no setter at all.
	 */
	setTaskState<T extends TaskStateWritableKey>(key: T, value: TaskState[T]): void

	/** Records the accepted completion response on task state. */
	commitCompletionResponse(response: string): void


	/** Activates a trusted skill and persists the activation for task resume. */
	activateSkill(skillId: string): Promise<void>

	/**
	 * Checks if the latest task completion has new changes.
	 */
	doesLatestTaskCompletionHaveNewChanges(): Promise<boolean>

	resetTransientState(): Promise<void>
	/** Reports that conversation truncation state was successfully persisted. */
	notifyContextCompacted(): void
}

export type CompletionCommitResult = { committed: true } | { committed: false; error: string }

export interface IResponseObserverTrait {
	recordResponse(response: ResponseArguments): Promise<void>
}

export type { TranscriptPage } from "@shared/messages/content"

export interface IGoalTrait {
	startTask(input: { taskTitle: string; prompt: string }): Promise<GoalChildRecord>
	listTasks(input: {
		status?: GoalChildStatus[]
		role?: GoalChildRole
		cursor?: string
		limit?: number
	}): Promise<{ tasks: GoalTaskSummary[]; nextCursor?: string }>
	sendTaskMessage(input: { taskId: string; message: string }): Promise<GoalChildRecord>
	cancelTask(input: { taskId: string; reason?: string }): Promise<GoalChildRecord>
	readTaskTranscript(input: { taskId: string; cursor?: string; limit?: number }): Promise<TranscriptPage>
	resolveTaskInteraction(input: {
		taskId: string
		interactionId: string
		resolution: "allow" | "reject" | "answer" | "passthrough"
		answer?: string
	}): Promise<{ resolved: true; task: GoalChildRecord }>
	waitForEvents(): Promise<string>
	startVerification(input: { focus?: string }): Promise<GoalChildRecord>
	replaceObjective(markdown: string): Promise<GoalObjectiveRevision>
	blockGoal(reason: string): Promise<void>
	commitCompletion(result: string): Promise<CompletionCommitResult>
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

	/**
	 * Formats diagnostics with optional anchored source context for model-facing output.
	 */
	formatProblems(
		diagnostics: FileDiagnostics[],
		fileContentMap?: Map<string, { lines: string[]; hashes?: string[] }>,
		maxErrors?: number,
	): Promise<string>
}

export interface ILoggingTrait {
	error(message: string, ...args: any[]): void
	warn(message: string, ...args: any[]): void
	info(message: string, ...args: any[]): void
	debug(message: string, ...args: any[]): void
	log(message: string, ...args: any[]): void
	trace(message: string, ...args: any[]): void
}

export interface IAnchorTrait {
	reconcile(absolutePath: string, lines: string[]): string[]
	getDocumentFingerprint(absolutePath: string): string | null
	clear(absolutePath: string): void
}

/**
 * The Tool Environment provides access to all capabilities (traits)
 * available to a modular tool during its execution.
 */
export interface ConversationCondensationResult {
	text: string
	modelIdentity: {
		providerId: string
		modelId: string
	}
}

export interface IConversationCondensationTrait {
	isAvailable(template: TextCondensationTemplateId): boolean
	condenseConversation(
		template: TextCondensationTemplateId,
		options: {
			historyScope: "complete" | "effective"
			signal?: AbortSignal
			additionalSourceText?: string
		},
	): Promise<ConversationCondensationResult>
}

export interface IToolEnvironment {
	readonly telemetry: ITelemetryTrait
	readonly ui: IUITrait
	readonly interaction: IInteractionTrait
	readonly system: ISystemTrait
	readonly workspace: IWorkspaceTrait
	readonly sourceAst: ISourceAstTrait
	/** Absent when the host cannot supply editor diagnostics. */
	readonly diagnostics?: IDiagnosticsTrait

	readonly anchors: IAnchorTrait
	readonly editor: IEditorTrait
	readonly browser: IBrowserTrait
	readonly skills: ISkillsTrait
	/** Only foreground conversations own architecture storage; absent for private workers. */
	readonly architecture?: IArchitectureTrait
	readonly orchestration: IOrchestrationTrait
	readonly responseObserver: IResponseObserverTrait
	readonly goal?: IGoalTrait
	/** Available only to task environments that own their conversation history. */
	readonly conversationCondensation?: IConversationCondensationTrait

	/** Persistent state management */
	readonly context: IDiracContext

	/** The name of the tool being executed */
	readonly toolName: string

	/** Task and environment configuration */
	readonly config: TaskConfig

	/** Structured logging access for tools */
	readonly logging: ILoggingTrait
}
