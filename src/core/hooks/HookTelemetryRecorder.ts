import { telemetryService } from "../../services/telemetry"
import type { HookOutput } from "../../shared/proto/dirac/hooks"
import type { HookExecutionError } from "./HookError"

// Exit code indicating cancellation/interruption (Unix SIGINT convention: 128 + signal 2)
const EXIT_CODE_SIGINT = 130

/** Context for hook telemetry — source, tool name, and hook name. */
export interface HookTelemetryContext {
	hookName: string
	source: "global" | "workspace"
	toolName?: string
}

/**
 * Records telemetry events for hook execution lifecycle.
 * Captures started, completed (success/cancel), failed, and cancelled events.
 */
export class HookTelemetryRecorder {
	/** Captures telemetry at the start of individual hook execution. */
	static captureStarted(taskId: string, ctx: HookTelemetryContext): void {
		telemetryService.safeCapture(
			() =>
				telemetryService.captureHookExecution(taskId, ctx.hookName, "started", {
					source: ctx.source,
					toolName: ctx.toolName,
				}),
			"HookFactory.exec.started",
		)
	}

	/** Captures success/cancellation telemetry for a completed hook with valid JSON. */
	static captureCompleted(
		taskId: string,
		ctx: HookTelemetryContext,
		output: HookOutput,
		exitCode: number | null,
		durationMs: number,
	): void {
		if (output.cancel) {
			HookTelemetryRecorder.captureCancelCompleted(taskId, ctx, output, exitCode, durationMs)
		} else {
			HookTelemetryRecorder.captureSuccessCompleted(taskId, ctx, output, exitCode, durationMs)
		}
	}

	/** Captures telemetry for a hook that completed without JSON output. */
	static captureNoJson(taskId: string, ctx: HookTelemetryContext, durationMs: number): void {
		telemetryService.safeCapture(
			() =>
				telemetryService.captureHookExecution(taskId, ctx.hookName, "completed", {
					source: ctx.source,
					toolName: ctx.toolName,
					durationMs,
					exitCode: 0,
					cancelRequested: false,
					contextModified: false,
				}),
			"HookFactory.exec.completed.noJson",
		)
	}

	/** Captures telemetry for a HookExecutionError based on its type. */
	static captureHookError(taskId: string, ctx: HookTelemetryContext, error: HookExecutionError, durationMs: number): void {
		if (error.errorInfo.type === "cancellation") {
			HookTelemetryRecorder.captureCancelled(taskId, ctx, "HookFactory.exec.error.cancellation")
		} else if (error.errorInfo.type === "timeout") {
			HookTelemetryRecorder.captureFailed(
				taskId,
				ctx,
				{
					durationMs,
					errorType: "timeout",
					errorMessage: error.message,
				},
				"HookFactory.exec.error.timeout",
			)
		} else {
			HookTelemetryRecorder.captureFailed(
				taskId,
				ctx,
				{
					durationMs,
					exitCode: error.errorInfo.exitCode ?? 1,
					errorType: error.errorInfo.type as "execution" | "timeout" | "validation",
					errorMessage: error.message,
				},
				"HookFactory.exec.error.failed",
			)
		}
	}

	/** Captures telemetry for a timeout error caught in the catch block. */
	static captureTimeout(taskId: string, ctx: HookTelemetryContext, durationMs: number, error: Error): void {
		HookTelemetryRecorder.captureFailed(
			taskId,
			ctx,
			{
				durationMs,
				errorType: "timeout",
				errorMessage: error.message,
			},
			"HookFactory.exec.catch.timeout",
		)
	}

	/** Captures telemetry for a cancellation error caught in the catch block. */
	static captureCancellation(taskId: string, ctx: HookTelemetryContext): void {
		HookTelemetryRecorder.captureCancelled(taskId, ctx, "HookFactory.exec.catch.cancelled")
	}

	/** Captures telemetry for a generic execution error caught in the catch block. */
	static captureGenericError(
		taskId: string,
		ctx: HookTelemetryContext,
		durationMs: number,
		exitCode: number | null,
		error: unknown,
	): void {
		HookTelemetryRecorder.captureFailed(
			taskId,
			ctx,
			{
				durationMs,
				exitCode: exitCode ?? 1,
				errorType: "execution",
				errorMessage: error instanceof Error ? error.message : String(error),
			},
			"HookFactory.exec.catch.execution",
		)
	}

	private static captureCancelCompleted(
		taskId: string,
		ctx: HookTelemetryContext,
		output: HookOutput,
		exitCode: number | null,
		durationMs: number,
	): void {
		telemetryService.safeCapture(
			() =>
				telemetryService.captureHookExecution(taskId, ctx.hookName, "completed", {
					source: ctx.source,
					toolName: ctx.toolName,
					durationMs,
					exitCode: exitCode ?? EXIT_CODE_SIGINT,
					cancelRequested: true,
					contextModified: !!output.contextModification,
					contextSize: output.contextModification?.length,
				}),
			"HookFactory.exec.completed.cancel",
		)
	}

	private static captureSuccessCompleted(
		taskId: string,
		ctx: HookTelemetryContext,
		output: HookOutput,
		exitCode: number | null,
		durationMs: number,
	): void {
		telemetryService.safeCapture(
			() =>
				telemetryService.captureHookExecution(taskId, ctx.hookName, "completed", {
					source: ctx.source,
					toolName: ctx.toolName,
					durationMs,
					exitCode: exitCode ?? 0,
					cancelRequested: false,
					contextModified: !!output.contextModification,
					contextSize: output.contextModification?.length,
				}),
			"HookFactory.exec.completed.success",
		)
	}

	private static captureCancelled(taskId: string, ctx: HookTelemetryContext, event: string): void {
		telemetryService.safeCapture(
			() =>
				telemetryService.captureHookExecution(taskId, ctx.hookName, "cancelled", {
					source: ctx.source,
					toolName: ctx.toolName,
				}),
			event,
		)
	}

	private static captureFailed(
		taskId: string,
		ctx: HookTelemetryContext,
		props: {
			durationMs: number
			exitCode?: number
			errorType: "timeout" | "execution" | "validation"
			errorMessage: string
		},
		event: string,
	): void {
		telemetryService.safeCapture(
			() =>
				telemetryService.captureHookExecution(taskId, ctx.hookName, "failed", {
					source: ctx.source,
					toolName: ctx.toolName,
					...props,
				}),
			event,
		)
	}
}
