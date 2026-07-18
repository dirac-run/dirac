import type { Controller } from "@/core/controller"

/**
 * Common options shared between runTask and resumeTask
 */
export interface TaskOptions {
	act?: boolean
	plan?: boolean
	provider?: string
	kanban?: boolean
	model?: string
	verbose?: boolean
	cwd?: string
	continue?: boolean
	config?: string
	thinking?: boolean | string
	reasoningEffort?: string
	maxConsecutiveMistakes?: string
	yolo?: boolean
	autoApproveAll?: boolean
	doubleCheckCompletion?: boolean
	autoCondense?: boolean
	timeout?: string
	json?: boolean
	stdinWasPiped?: boolean
	hooksDir?: string
	subagents?: boolean
	headers?: string
	noIndex?: boolean

	noEmoji?: boolean
	format?: "json" | "ansi" | "plain"
}

export interface CliContext {
	extensionContext: any
	dataDir: string
	extensionDir: string
	workspacePath: string
	controller: Controller
}

export interface InitOptions {
	config?: string
	cwd?: string
	hooksDir?: string
	verbose?: boolean
	enableAuth?: boolean
	noIndex?: boolean
}
