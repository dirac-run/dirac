import type {
	ActionButton,
	Card,
	CardLocation,
	CardStatus,
	CleanupStrategy,
	RenderType,
	CardParams as SharedCardParams,
} from "@shared/ExtensionMessage"
import type { DiracAskResponse } from "@shared/WebviewMessage"

export interface ICardHandle {
	readonly collapsed: boolean
	readonly id: string
	readonly header: string
	readonly icon?: string
	readonly renderType: RenderType
	readonly body?: string

	readonly rawInput?: import("../../../../shared/ExtensionMessage").CardRawInput
	readonly rawOutput?: import("../../../../shared/ExtensionMessage").CardRawOutput
	readonly locations?: CardLocation[]
	readonly requireApproval?: boolean
	readonly requireFeedback?: boolean
	readonly feedbackPlaceholder?: string
	readonly actions?: ActionButton[]
	readonly maxHeight?: number
	readonly cleanupStrategy?: CleanupStrategy
	readonly status: CardStatus
	/** Whether waitForInteraction will actually suspend for user input. */
	readonly requiresUserInteraction?: boolean

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
	 * Append a small, bounded status update to the existing body.
	 * Callers must not use this for unbounded stdout or log streaming.
	 */
	appendBody(chunk: string): Promise<void>

	/**
	 * Transitions the card to a final state and resolves any pending interaction.
	 */
	finalize(status: CardStatus, doNotAutoCollapse?: boolean): Promise<void>
}

/** Runtime-resolved operation, never supplied by a parent approval response. */
export type PermissionOperation =
	| { kind: "commands"; commands: string[]; executionContexts?: { command: string; cwd: string }[] }
	| { kind: "paths"; paths: string[] }
	| { kind: "browser"; url: string }
	| { kind: "tool"; manualOnly: boolean }

export interface CardParams extends SharedCardParams {
	/**
	 * Classifies tool permissions for the shared approval pipeline.
	 * Utility may approve `tool`; `manual_tool` requires the user unless an explicit unrestricted mode is active.
	 */
	permissionRequestKind?: "tool" | "manual_tool"
	permissionOperation?: PermissionOperation
	/** Prior child Utility escalation; the owner must not repeat the same evaluation. */
	utilityPermissionEscalation?: string
	/** Display-only explanation when Utility was not consulted before the owner. */
	utilityPermissionSkipped?: string
	/** Operational choice (for example condensation), not a security grant. */
	operationalInput?: boolean
	/** Internal live predicate used to resolve a displayed tool permission after settings change. */
	isAutoApproved?: () => boolean
}
