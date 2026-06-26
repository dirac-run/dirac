/**
 * Captures tool execution, skill, checkpoint, AI output acceptance/rejection,
 * provider API errors, and Gemini API performance telemetry.
 * Extracted from TelemetryService to enforce SRP — tool-domain events are isolated from task lifecycle.
 */
import type { TelemetryCategoryGate } from "./TelemetryCategoryGate"
import type { TelemetryEventEmitter } from "./TelemetryEventEmitter"
import { TELEMETRY_EVENTS } from "./TelemetryEvents"
import { TELEMETRY_METRICS } from "./TelemetryMetrics"
import type { TelemetrySessionTracker } from "./TelemetrySessionTracker"

const MAX_ERROR_MESSAGE_LENGTH = 500

export class ToolTelemetry {
	private static readonly EVENTS = TELEMETRY_EVENTS.TASK
	private static readonly METRICS = TELEMETRY_METRICS

	constructor(
		private readonly emitter: TelemetryEventEmitter,
		private readonly sessionTracker: TelemetrySessionTracker,
		private readonly categoryGate: TelemetryCategoryGate,
	) {}

	captureToolUsage(
		ulid: string,
		tool: string,
		modelId: string,
		provider: string,
		autoApproved: boolean,
		success: boolean,
		metadata?: {
			isMultiRootEnabled?: boolean
			usedWorkspaceHint?: boolean
			resolvedToNonPrimary?: boolean
			resolutionMethod?: "hint" | "primary_fallback" | "path_detection"
			durationMs?: number
			modular?: boolean
			commandCount?: number
		},
		isNativeToolCall = false,
	): void {
		this.emitter.capture({
			event: ToolTelemetry.EVENTS.TOOL_USED,
			properties: {
				ulid,
				tool,
				autoApproved,
				success,
				modelId,
				provider,
				durationMs: metadata?.durationMs,
				modular: metadata?.modular,
				commandCount: metadata?.commandCount,
				...(metadata && {
					workspace_multi_root_enabled: metadata.isMultiRootEnabled,
					workspace_hint_used: metadata.usedWorkspaceHint,
					workspace_resolved_non_primary: metadata.resolvedToNonPrimary,
					workspace_resolution_method: metadata.resolutionMethod,
				}),
				isNativeToolCall,
			},
		})
		const toolAttributes = { ulid, tool, model: modelId, success, autoApproved }
		const toolCallCount = this.sessionTracker.incrementToolCallCount(ulid)
		this.emitter.recordCounter(ToolTelemetry.METRICS.TOOLS.CALLS_TOTAL, 1, toolAttributes)
		this.emitter.recordHistogram(ToolTelemetry.METRICS.TOOLS.CALLS_PER_TASK, toolCallCount, toolAttributes)
	}

	captureSkillUsed(args: {
		ulid: string
		skillName: string
		skillSource: "global" | "project"
		skillsAvailableGlobal: number
		skillsAvailableProject: number
		provider?: string
		modelId?: string
	}): void {
		if (!this.categoryGate.isEnabled("skills")) {
			return
		}
		if (!args.ulid || !args.skillName) {
			return
		}
		const skillsAvailableGlobal = Math.max(0, args.skillsAvailableGlobal)
		const skillsAvailableProject = Math.max(0, args.skillsAvailableProject)
		this.emitter.capture({
			event: ToolTelemetry.EVENTS.SKILL_USED,
			properties: {
				ulid: args.ulid,
				skillName: args.skillName,
				skillSource: args.skillSource,
				skillsAvailableGlobal,
				skillsAvailableProject,
				provider: args.provider,
				modelId: args.modelId,
			},
		})
	}

	captureCheckpointUsage(
		ulid: string,
		action: "shadow_git_initialized" | "commit_created" | "restored" | "diff_generated",
		durationMs?: number,
	): void {
		if (!this.categoryGate.isEnabled("checkpoints")) {
			return
		}
		this.emitter.capture({
			event: ToolTelemetry.EVENTS.CHECKPOINT_USED,
			properties: { ulid, action, durationMs },
		})
	}

	captureProviderApiError(args: {
		ulid: string
		model: string
		errorMessage: string
		provider?: string
		errorStatus?: number | undefined
		requestId?: string | undefined
		isNativeToolCall?: boolean
	}): void {
		this.emitter.capture({
			event: ToolTelemetry.EVENTS.PROVIDER_API_ERROR,
			properties: {
				...args,
				errorMessage: args.errorMessage.substring(0, MAX_ERROR_MESSAGE_LENGTH),
				timestamp: new Date().toISOString(),
			},
		})
		this.emitter.recordCounter(ToolTelemetry.METRICS.ERRORS.TOTAL, 1, {
			ulid: args.ulid,
			model: args.model,
			provider: args.provider,
			error_status: args.errorStatus,
		})
		const errorAttributes = {
			ulid: args.ulid,
			model: args.model,
			provider: args.provider,
			error_status: args.errorStatus,
		}
		const errorCount = this.sessionTracker.incrementErrorCount(args.ulid)
		this.emitter.recordHistogram(ToolTelemetry.METRICS.ERRORS.PER_TASK, errorCount, errorAttributes)
	}

	captureGeminiApiPerformance(
		ulid: string,
		modelId: string,
		data: {
			ttftSec?: number
			totalDurationSec?: number
			promptTokens: number
			outputTokens: number
			cacheReadTokens: number
			cacheHit: boolean
			cacheHitPercentage?: number
			apiSuccess: boolean
			apiError?: string
			throughputTokensPerSec?: number
		},
	): void {
		this.emitter.capture({
			event: ToolTelemetry.EVENTS.GEMINI_API_PERFORMANCE,
			properties: { ulid, modelId, ...data },
		})
		if (typeof data.ttftSec === "number") {
			this.emitter.recordHistogram(ToolTelemetry.METRICS.API.TTFT_SECONDS, data.ttftSec, {
				ulid,
				model: modelId,
				provider: "gemini",
			})
		}
		if (typeof data.totalDurationSec === "number") {
			this.emitter.recordHistogram(ToolTelemetry.METRICS.API.DURATION_SECONDS, data.totalDurationSec, {
				ulid,
				model: modelId,
				provider: "gemini",
			})
		}
		if (typeof data.throughputTokensPerSec === "number") {
			this.emitter.recordHistogram(ToolTelemetry.METRICS.API.THROUGHPUT_TOKENS_PER_SECOND, data.throughputTokensPerSec, {
				ulid,
				model: modelId,
				provider: "gemini",
			})
		}
		if (data.cacheHit) {
			this.emitter.recordCounter(ToolTelemetry.METRICS.CACHE.HITS_TOTAL, 1, { ulid, model: modelId, provider: "gemini" })
		}
	}

	captureAiOutputAccepted(args: {
		ulid: string
		tool: string
		provider?: string
		model?: string
		source: "agent" | "human"
		linesAdded: number
		linesDeleted: number
		linesChanged: number
		filesCreated?: number
		filesDeleted?: number
		filesMoved?: number
	}): void {
		this.emitter.capture({
			event: "task.ai_output.accepted",
			properties: {
				ulid: args.ulid,
				tool: args.tool,
				provider: args.provider,
				model: args.model,
				source: args.source,
				linesAdded: args.linesAdded,
				linesDeleted: args.linesDeleted,
				linesChanged: args.linesChanged,
				filesCreated: args.filesCreated ?? 0,
				filesDeleted: args.filesDeleted ?? 0,
				filesMoved: args.filesMoved ?? 0,
			},
		})
		const attrs = { ulid: args.ulid, tool: args.tool, provider: args.provider, model: args.model, source: args.source }
		this.emitter.recordCounter(ToolTelemetry.METRICS.AI_OUTPUT.ACCEPTED_LINES_ADDED, args.linesAdded, attrs)
		this.emitter.recordCounter(ToolTelemetry.METRICS.AI_OUTPUT.ACCEPTED_LINES_DELETED, args.linesDeleted, attrs)
		this.emitter.recordCounter(ToolTelemetry.METRICS.AI_OUTPUT.ACCEPTED_LINES_CHANGED, args.linesChanged, attrs)
		if (args.filesCreated) {
			this.emitter.recordCounter(ToolTelemetry.METRICS.AI_OUTPUT.ACCEPTED_FILES_CREATED, args.filesCreated, attrs)
		}
		if (args.filesDeleted) {
			this.emitter.recordCounter(ToolTelemetry.METRICS.AI_OUTPUT.ACCEPTED_FILES_DELETED, args.filesDeleted, attrs)
		}
		if (args.filesMoved) {
			this.emitter.recordCounter(ToolTelemetry.METRICS.AI_OUTPUT.ACCEPTED_FILES_MOVED, args.filesMoved, attrs)
		}
	}

	captureAiOutputRejected(args: {
		ulid: string
		tool: string
		provider?: string
		model?: string
		source: "agent" | "human"
		linesAdded: number
		linesDeleted: number
		linesChanged: number
		filesCreated?: number
		filesDeleted?: number
		filesMoved?: number
	}): void {
		this.emitter.capture({
			event: "task.ai_output.rejected",
			properties: {
				ulid: args.ulid,
				tool: args.tool,
				provider: args.provider,
				model: args.model,
				source: args.source,
				linesAdded: args.linesAdded,
				linesDeleted: args.linesDeleted,
				linesChanged: args.linesChanged,
				filesCreated: args.filesCreated ?? 0,
				filesDeleted: args.filesDeleted ?? 0,
				filesMoved: args.filesMoved ?? 0,
			},
		})
		const attrs = { ulid: args.ulid, tool: args.tool, provider: args.provider, model: args.model, source: args.source }
		this.emitter.recordCounter(ToolTelemetry.METRICS.AI_OUTPUT.REJECTED_LINES_ADDED, args.linesAdded, attrs)
		this.emitter.recordCounter(ToolTelemetry.METRICS.AI_OUTPUT.REJECTED_LINES_DELETED, args.linesDeleted, attrs)
		this.emitter.recordCounter(ToolTelemetry.METRICS.AI_OUTPUT.REJECTED_LINES_CHANGED, args.linesChanged, attrs)
		if (args.filesCreated) {
			this.emitter.recordCounter(ToolTelemetry.METRICS.AI_OUTPUT.REJECTED_FILES_CREATED, args.filesCreated, attrs)
		}
		if (args.filesDeleted) {
			this.emitter.recordCounter(ToolTelemetry.METRICS.AI_OUTPUT.REJECTED_FILES_DELETED, args.filesDeleted, attrs)
		}
		if (args.filesMoved) {
			this.emitter.recordCounter(ToolTelemetry.METRICS.AI_OUTPUT.REJECTED_FILES_MOVED, args.filesMoved, attrs)
		}
	}
}
