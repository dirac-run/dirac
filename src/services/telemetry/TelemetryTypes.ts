/**
 * Telemetry type definitions and enums.
 * Extracted from TelemetryService to reduce class size.
 */

/**
 * Represents telemetry event categories that can be individually enabled or disabled
 * When adding a new category, add it both here and to the initial values in telemetryCategoryEnabled
 * Ensure `if (!this.isCategoryEnabled('<category_name>')` is added to the capture method
 */
export type TelemetryCategory = "checkpoints" | "browser" | "subagents" | "skills" | "hooks"

/** Terminal type for telemetry differentiation */
export type TerminalType = "vscode" | "standalone"

/** VSCode-specific output capture methods */
export type VscodeOutputMethod = "shell_integration" | "clipboard" | "none"

/** Standalone-specific output capture methods */
export type StandaloneOutputMethod = "child_process" | "child_process_error"

/** Combined type for terminal output methods */
export type TerminalOutputMethod = VscodeOutputMethod | StandaloneOutputMethod

/** Enum for terminal output failure reasons */
export enum TerminalOutputFailureReason {
	TIMEOUT = "timeout",
	NO_SHELL_INTEGRATION = "no_shell_integration",
	CLIPBOARD_FAILED = "clipboard_failed",
}

/** Enum for terminal user intervention actions */
export enum TerminalUserInterventionAction {
	PROCESS_WHILE_RUNNING = "process_while_running",
	MANUAL_PASTE = "manual_paste",
	CANCELLED = "cancelled",
}

/** Enum for terminal hang stages */
export enum TerminalHangStage {
	WAITING_FOR_COMPLETION = "waiting_for_completion",
	BUFFER_STUCK = "buffer_stuck",
	STREAM_TIMEOUT = "stream_timeout",
}

export type TelemetryMetadata = {
	/**
	 * The extension or dirac-core version. JetBrains and CLI have different
	 * versioning than the VSCode Extension, but on those platforms this will be the _dirac-core version_
	 * which uses the same as the versioning as the VSCode extension.
	 */
	extension_version: string
	/**
	 * The type of dirac distribution, e.g VSCode Extension, JetBrains Plugin or CLI. This
	 * is different than the `platform` because there are many variants of VSCode and JetBrains but they
	 * all use the same extension or plugin.
	 */
	dirac_type: string
	/** The name of the host IDE or environment e.g. VSCode, Cursor, IntelliJ Professional Edition, etc. */
	platform: string
	/** The version of the host environment */
	platform_version: string
	/** The operating system type, e.g. darwin, win32. This is the value returned by os.platform() */
	os_type: string
	/** The operating system version e.g. 'Windows 10 Pro', 'Darwin Kernel Version 21.6.0...' */
	os_version: string
	/** Whether the extension is running in development mode */
	is_dev: string | undefined
}

/**
 * Token usage data shared across telemetry capture methods.
 * Used by both `captureTokenUsage` and `captureConversationTurnEvent`.
 */
export interface TokenUsage {
	tokensIn?: number
	tokensOut?: number
	cacheWriteTokens?: number
	cacheReadTokens?: number
	totalCost?: number
}
