import { Logger } from "@/shared/services/Logger"
import { version as diracVersion } from "../../../package.json"
import { getDistinctId } from "../../services/logging/distinctId"
import { telemetryService } from "../../services/telemetry"
import {
	HookInput,
	HookModelContext,
	HookOutput,
	NotificationData,
	PostToolUseData,
	PreCompactData,
	PreToolUseData,
	TaskCancelData,
	TaskCompleteData,
	TaskResumeData,
	TaskStartData,
	UserPromptSubmitData,
} from "../../shared/proto/dirac/hooks"
import { getAllHooksDirs } from "../storage/disk"
import { StateManager } from "../storage/StateManager"
import { HookConfigBuilder } from "./HookConfigBuilder"
import { HookExecutionError } from "./HookError"
import { HookProcess } from "./HookProcess"
import { HookRegistry } from "./HookRegistry"
import { HookResponseParser } from "./HookResponseParser"
import { type HookTelemetryContext, HookTelemetryRecorder } from "./HookTelemetryRecorder"

// Hook execution timeout (10 seconds)
const HOOK_EXECUTION_TIMEOUT_MS = 10000

export interface Hooks {
	PreToolUse: {
		preToolUse: PreToolUseData
	}
	PostToolUse: {
		postToolUse: PostToolUseData
	}
	UserPromptSubmit: {
		userPromptSubmit: UserPromptSubmitData
	}
	TaskStart: {
		taskStart: TaskStartData
	}
	TaskResume: {
		taskResume: TaskResumeData
	}
	TaskCancel: {
		taskCancel: TaskCancelData
	}
	TaskComplete: {
		taskComplete: TaskCompleteData
	}
	Notification: {
		notification: NotificationData
	}
	PreCompact: {
		preCompact: PreCompactData
	}
}

export interface HookModelInputContext {
	provider?: string
	slug?: string
}

// The names of all supported hooks. Hooks[N] is the type of data the hook takes as input.
type HookName = keyof Hooks

/** Hook input parameters for a named hook — caller provides these; common metadata is added by the hook system. */
export type NamedHookInput<Name extends HookName> = {
	taskId: string
	model?: HookModelInputContext
} & Hooks[Name]

// Symbol-based exec lookup so CombinedHookRunner can call sub-runners without re-completing params
const exec = Symbol()

/** Runs a hook script and returns the result. Stateless and reusable — each run() is independent. */
export abstract class HookRunner<Name extends HookName> {
	constructor(public readonly hookName: Name) {}

	/** Execute the hook with the given parameters. Stateless — safe to call multiple times. */
	async run(params: NamedHookInput<Name>): Promise<HookOutput> {
		const input = HookInput.create(await this.completeParams(params))
		return this[exec](input)
	}

	abstract [exec](params: HookInput): Promise<HookOutput>

	/** Enriches hook-specific input with standard metadata: diracVersion, hookName, timestamp, workspaceRoots, userId. */
	protected async completeParams(params: NamedHookInput<Name>): Promise<HookInput> {
		const workspaceRoots =
			StateManager.get()
				.getGlobalStateKey("workspaceRoots")
				?.map((root) => root.path) || []

		const model: HookModelContext = {
			provider: params.model?.provider?.trim() || "unknown",
			slug: params.model?.slug?.trim() || "unknown",
		}

		return {
			diracVersion,
			hookName: this.hookName,
			timestamp: Date.now().toString(),
			workspaceRoots,
			userId: getDistinctId(), // Always available: Dirac User ID, machine ID, or generated UUID
			...params,
			model,
		}
	}
}

/** NoOpRunner — null-object pattern: always succeeds immediately when no hook scripts are found. */
class NoOpRunner<Name extends HookName> extends HookRunner<Name> {
	override async [exec](_: HookInput): Promise<HookOutput> {
		return HookOutput.create({ cancel: false })
	}
}

/** Callback type for streaming hook output */
export type HookStreamCallback = (
	line: string,
	stream: "stdout" | "stderr",
	meta?: {
		source: "global" | "workspace"
		scriptPath: string
	},
) => void

/** Executes a hook script as a child process with real-time output streaming. Delegates parsing to HookResponseParser, telemetry to HookTelemetryRecorder. Fail-open: only explicit JSON cancel:true blocks execution. */
class StdioHookRunner<Name extends HookName> extends HookRunner<Name> {
	constructor(
		hookName: Name,
		public readonly scriptPath: string,
		private readonly source: "global" | "workspace",
		private readonly streamCallback?: HookStreamCallback,
		private readonly abortSignal?: AbortSignal,
		private readonly taskId?: string,
		private readonly toolName?: string,
		private readonly cwd?: string,
	) {
		super(hookName)
	}

	override async [exec](input: HookInput): Promise<HookOutput> {
		const startTime = performance.now()
		const taskId = this.taskId // Local const for type narrowing in closures
		const telemetryCtx: HookTelemetryContext = { hookName: this.hookName, source: this.source, toolName: this.toolName }

		// Capture telemetry at the start of individual hook execution
		if (taskId) HookTelemetryRecorder.captureStarted(taskId, telemetryCtx)

		// Check if already aborted before starting
		if (this.abortSignal?.aborted) throw HookExecutionError.cancellation(this.scriptPath)

		// Serialize input to JSON — manually construct to preserve empty string fields (proto3 omits defaults)
		const jsonObj = HookInput.toJSON(input) as Record<string, any>
		if (jsonObj.userPromptSubmit && jsonObj.userPromptSubmit.prompt === undefined) {
			jsonObj.userPromptSubmit.prompt = ""
		}
		const inputJson = JSON.stringify(jsonObj)

		// Create HookProcess for execution with streaming
		const hookProcess = new HookProcess(this.scriptPath, HOOK_EXECUTION_TIMEOUT_MS, this.abortSignal, this.cwd)
		if (this.streamCallback) {
			const callback = this.streamCallback
			hookProcess.on("line", (line: string, stream: "stdout" | "stderr") => {
				// NOTE: HookProcess emits a synthetic empty line ("") as a "start of output" marker — preserve it
				callback(line, stream, { source: this.source, scriptPath: this.scriptPath })
			})
		}

		try {
			await hookProcess.run(inputJson)

			const stdout = hookProcess.getStdout()
			const stderr = hookProcess.getStderr()
			const exitCode = hookProcess.getExitCode()

			// Parse JSON output from stdout (handles mixed debug output and validation)
			const parsedOutput = HookResponseParser.parse(stdout, this.hookName)

			// If we have valid JSON, honor it regardless of exit code
			if (parsedOutput) {
				const durationMs = performance.now() - startTime

				// Log warning if non-zero exit but valid JSON (for developers)
				if (exitCode !== 0) {
					Logger.warn(`[Hook ${this.hookName}] Exited with code ${exitCode} but provided valid JSON response`)
					if (stderr) Logger.warn(`[Hook ${this.hookName}] stderr: ${stderr}`)
				}

				// Capture success/cancellation telemetry
				if (taskId) HookTelemetryRecorder.captureCompleted(taskId, telemetryCtx, parsedOutput, exitCode, durationMs)

				return parsedOutput
			}

			// No valid JSON found — hook succeeded but didn't provide JSON, allow execution
			if (exitCode === 0) {
				Logger.warn(`[Hook ${this.hookName}] Completed successfully but no JSON response found`)
				const durationMs = performance.now() - startTime
				if (taskId) HookTelemetryRecorder.captureNoJson(taskId, telemetryCtx, durationMs)
				return HookOutput.create({ cancel: false })
			}

			// Hook failed with non-zero exit — include hook name in error
			throw HookExecutionError.execution(this.scriptPath, exitCode ?? 1, stderr, this.hookName)
		} catch (error) {
			const durationMs = performance.now() - startTime

			// If it's already a HookExecutionError, capture telemetry and re-throw
			if (HookExecutionError.isHookError(error)) {
				if (taskId) HookTelemetryRecorder.captureHookError(taskId, telemetryCtx, error, durationMs)
				throw error
			}

			// Hook execution failed — categorize the error
			const stderr = hookProcess.getStderr()
			const exitCode = hookProcess.getExitCode()

			// Check for timeout
			if (error instanceof Error && error.message.includes("timed out")) {
				if (taskId) HookTelemetryRecorder.captureTimeout(taskId, telemetryCtx, durationMs, error)
				throw HookExecutionError.timeout(this.scriptPath, HOOK_EXECUTION_TIMEOUT_MS, stderr, this.hookName)
			}

			// Check for cancellation
			if (error instanceof Error && error.message.includes("cancelled")) {
				if (taskId) HookTelemetryRecorder.captureCancellation(taskId, telemetryCtx)
				throw HookExecutionError.cancellation(this.scriptPath, this.hookName)
			}

			// Generic execution error — include hook name
			if (taskId) HookTelemetryRecorder.captureGenericError(taskId, telemetryCtx, durationMs, exitCode, error)
			throw HookExecutionError.execution(this.scriptPath, exitCode ?? 1, stderr, this.hookName)
		}
	}
}

/** Combines multiple hook runners — executes in parallel, any cancel wins, merges context and errors. */
class CombinedHookRunner<Name extends HookName> extends HookRunner<Name> {
	constructor(
		hookName: Name,
		private readonly runners: readonly HookRunner<Name>[],
	) {
		super(hookName)
	}

	override async [exec](input: HookInput): Promise<HookOutput> {
		// Run all hooks in parallel
		const results = await Promise.all(this.runners.map((runner) => runner[exec](input)))

		// Merge results: any cancel wins, combine context and errors
		const cancel = results.some((result) => result.cancel === true)
		const contextModification = results
			.map((result) => result.contextModification?.trim())
			.filter((mod) => mod)
			.join("\n\n")
		const errorMessage = results
			.map((result) => result.errorMessage?.trim())
			.filter((msg) => msg)
			.join("\n")

		return HookOutput.create({ cancel, contextModification, errorMessage })
	}
}

export class HookFactory {
	/** Get information about discovered hooks including their script paths. */
	async getHookInfo<Name extends HookName>(hookName: Name): Promise<{ scriptPaths: string[] }> {
		const { HookDiscoveryCache } = await import("./HookDiscoveryCache")
		const scripts = await HookDiscoveryCache.getInstance().get(hookName)
		return { scriptPaths: scripts }
	}

	/** Check if any hook scripts exist for the given hook name. */
	async hasHook<Name extends HookName>(hookName: Name): Promise<boolean> {
		const scripts = await HookRegistry.findHookScripts(hookName)
		return scripts.length > 0
	}

	/** Create a hook runner without streaming support (backwards compatible). */
	async create<Name extends HookName>(hookName: Name, taskId?: string, toolName?: string): Promise<HookRunner<Name>> {
		return this.createWithStreaming(hookName, undefined, undefined, taskId, toolName)
	}

	/**
	 * Create a hook runner with optional streaming callback and abort signal.
	 * Uses HookDiscoveryCache for discovery, HookConfigBuilder for source/cwd, returns NoOpRunner if none found or CombinedHookRunner if multiple.
	 */
	async createWithStreaming<Name extends HookName>(
		hookName: Name,
		streamCallback?: HookStreamCallback,
		abortSignal?: AbortSignal,
		taskId?: string,
		toolName?: string,
	): Promise<HookRunner<Name>> {
		// Use cache for hook discovery instead of direct file system scan
		const { HookDiscoveryCache } = await import("./HookDiscoveryCache")
		const scripts = await HookDiscoveryCache.getInstance().get(hookName)

		// Fetch hooks dirs once for source determination and telemetry
		const hooksDirs = await getAllHooksDirs()

		// Capture hook discovery telemetry — categorize scripts by location (global vs workspace)
		const { globalCount, workspaceCount } = HookConfigBuilder.categorizeHookScripts(scripts, hooksDirs)
		if (scripts.length > 0) {
			telemetryService.safeCapture(
				() => telemetryService.captureHookDiscovery(hookName, globalCount, workspaceCount),
				"HookFactory.createWithStreaming.discovery",
			)
		}

		// Get workspace roots for cwd determination
		const stateManager = StateManager.get()
		const workspaceRoots = stateManager.getGlobalStateKey("workspaceRoots")
		const primaryRootIndex = stateManager.getGlobalStateKey("primaryRootIndex") ?? 0
		const primaryCwd = workspaceRoots?.[primaryRootIndex]?.path

		// Create runners with source and cwd determination for each script
		// Global hooks run from primary workspace root, workspace hooks from their workspace root
		const runners = scripts.map((script) => {
			const source = HookConfigBuilder.determineScriptSource(script, hooksDirs)
			const cwd = HookConfigBuilder.determineHookCwd(script, hooksDirs, workspaceRoots, primaryCwd)
			return new StdioHookRunner(hookName, script, source, streamCallback, abortSignal, taskId, toolName, cwd)
		})

		if (runners.length === 0) return new NoOpRunner(hookName)
		return runners.length === 1 ? runners[0] : new CombinedHookRunner(hookName, runners)
	}
}
