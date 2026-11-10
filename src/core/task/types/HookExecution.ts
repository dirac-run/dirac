/**
 * Represents an active hook execution that can be cancelled.
 * This is tracked in TaskState to allow cancellation via UI or programmatic triggers.
 */
export interface HookExecution {
	/** Stable identity allocated before hook discovery or presentation starts. */
	runId: string
	/** The name of the hook being executed (e.g., "PreToolUse", "PostToolUse") */
	hookName: string
	/** The name of the tool that triggered this hook (for PreToolUse/PostToolUse hooks) */
	toolName?: string
	/** Presentation identity, populated once the hook card has been created. */
	messageId?: string

	/** The abort controller used to cancel the hook execution */
	abortController: AbortController
	/** Settles after the hook process and its status/ownership cleanup finish. */
	completion: Promise<void>
}
