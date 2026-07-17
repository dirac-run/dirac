/**
 * Captures task lifecycle telemetry: creation, completion, conversation turns, token usage,
 * mode switches, feedback, and feature toggles within a task.
 * Extracted from TelemetryService to enforce SRP — task-domain events are isolated from other domains.
 */
import { ApiFormat, apiFormatToJSON } from "@shared/proto/dirac/models"
import { Logger } from "@/shared/services/Logger"
import { Mode } from "@/shared/storage/types"
import type { TaskFeedbackType } from "@shared/WebviewMessage"
import { TELEMETRY_EVENTS } from "./TelemetryEvents"
import type { TelemetryEventEmitter } from "./TelemetryEventEmitter"
import { TELEMETRY_METRICS } from "./TelemetryMetrics"
import type { TelemetrySessionTracker } from "./TelemetrySessionTracker"
import type { TokenUsage } from "./TelemetryTypes"

export class TaskTelemetry {
	private static readonly EVENTS = TELEMETRY_EVENTS.TASK
	private static readonly METRICS = TELEMETRY_METRICS

	constructor(
		private readonly emitter: TelemetryEventEmitter,
		private readonly sessionTracker: TelemetrySessionTracker,
	) {}

	captureTaskCreated(ulid: string, apiProvider?: string, openAiCompatibleDomain?: string): void {
		this.sessionTracker.resetAggregates(ulid)
		this.emitter.capture({
			event: TaskTelemetry.EVENTS.CREATED,
			properties: { ulid, apiProvider, openAiCompatibleDomain },
		})
	}

	captureTaskRestarted(ulid: string, apiProvider?: string, openAiCompatibleDomain?: string): void {
		this.sessionTracker.resetAggregates(ulid)
		this.emitter.capture({
			event: TaskTelemetry.EVENTS.RESTARTED,
			properties: { ulid, apiProvider, openAiCompatibleDomain },
		})
	}

	captureTaskCompleted(
		ulid: string,
		args?: {
			provider?: string
			modelId?: string
			apiFormat?: ApiFormat
			timeToFirstTokenMs?: number
			durationMs?: number
			mode: Mode
		},
	): void {
		const apiFormatName = args?.apiFormat !== undefined ? apiFormatToJSON(args.apiFormat) : undefined
		this.emitter.capture({
			event: TaskTelemetry.EVENTS.COMPLETED,
			properties: {
				ulid,
				provider: args?.provider,
				modelId: args?.modelId,
				apiFormat: args?.apiFormat,
				apiFormatName,
				timeToFirstTokenMs: args?.timeToFirstTokenMs,
				durationMs: args?.durationMs,
				mode: args?.mode,
			},
		})
		if (Number.isFinite(args?.timeToFirstTokenMs)) {
			this.emitter.recordHistogram(TaskTelemetry.METRICS.API.TTFT_SECONDS, (args?.timeToFirstTokenMs ?? 0) / 1000, {
				ulid,
				provider: args?.provider,
				model: args?.modelId,
				apiFormat: apiFormatName,
				mode: args?.mode,
			})
		}
		if (Number.isFinite(args?.durationMs)) {
			this.emitter.recordHistogram(TaskTelemetry.METRICS.API.DURATION_SECONDS, (args?.durationMs ?? 0) / 1000, {
				ulid,
				provider: args?.provider,
				model: args?.modelId,
				apiFormat: apiFormatName,
				scope: "task",
				mode: args?.mode,
			})
		}
		this.sessionTracker.resetAggregates(ulid)
	}

	captureConversationTurnEvent(
		ulid: string,
		provider = "unknown",
		model = "unknown",
		source: "user" | "assistant",
		mode: Mode,
		tokenUsage: TokenUsage = {},
		isNativeToolCall?: boolean,
	): void {
		if (!ulid || !provider || !model || !source) {
			Logger.warn("TelemetryService: Missing required parameters for message capture")
			return
		}
		this.emitter.capture({
			event: TaskTelemetry.EVENTS.CONVERSATION_TURN,
			properties: {
				ulid,
				provider,
				model,
				source,
				mode,
				timestamp: new Date().toISOString(),
				...tokenUsage,
				isNativeToolCall,
			},
		})
		const turnCount = this.sessionTracker.incrementTurnCount(ulid)
		const turnAttributes = { ulid, provider, model, source, mode }
		this.emitter.recordCounter(TaskTelemetry.METRICS.TASK.TURNS_TOTAL, 1, turnAttributes)
		this.emitter.recordHistogram(TaskTelemetry.METRICS.TASK.TURNS_PER_TASK, turnCount, turnAttributes)
		if (Number.isFinite(tokenUsage.cacheWriteTokens)) {
			const cacheWriteTokens = tokenUsage.cacheWriteTokens ?? 0
			this.emitter.recordCounter(TaskTelemetry.METRICS.CACHE.WRITE_TOTAL, cacheWriteTokens, { ulid, provider, model, mode })
			this.emitter.recordHistogram(TaskTelemetry.METRICS.CACHE.WRITE_PER_EVENT, cacheWriteTokens, {
				ulid,
				provider,
				model,
				mode,
			})
		}
		if (Number.isFinite(tokenUsage.cacheReadTokens)) {
			const cacheReadTokens = tokenUsage.cacheReadTokens ?? 0
			this.emitter.recordCounter(TaskTelemetry.METRICS.CACHE.READ_TOTAL, cacheReadTokens, { ulid, provider, model, mode })
			this.emitter.recordHistogram(TaskTelemetry.METRICS.CACHE.READ_PER_EVENT, cacheReadTokens, {
				ulid,
				provider,
				model,
				mode,
			})
		}
		if (Number.isFinite(tokenUsage.totalCost)) {
			const totalCost = tokenUsage.totalCost ?? 0
			const costAttributes = { ulid, provider, model, mode, currency: "USD" }
			this.emitter.recordCounter(TaskTelemetry.METRICS.TASK.COST_TOTAL, totalCost, costAttributes)
			this.emitter.recordHistogram(TaskTelemetry.METRICS.TASK.COST_PER_EVENT, totalCost, costAttributes)
		}
	}

	captureTokenUsage(
		ulid: string,
		tokensIn: number,
		tokensOut: number,
		provider: string,
		model: string,
		options?: TokenUsage,
	): void {
		this.emitter.capture({
			event: TaskTelemetry.EVENTS.TOKEN_USAGE,
			properties: { ulid, tokensIn, tokensOut, provider, model, ...options },
		})
		const attributes = { ulid, provider, model }
		if (Number.isFinite(tokensIn)) {
			const value = tokensIn ?? 0
			this.emitter.recordCounter(TaskTelemetry.METRICS.TASK.TOKENS_INPUT_TOTAL, value, attributes)
			this.emitter.recordHistogram(TaskTelemetry.METRICS.TASK.TOKENS_INPUT_PER_RESPONSE, value, attributes)
		}
		if (Number.isFinite(tokensOut)) {
			const value = tokensOut ?? 0
			this.emitter.recordCounter(TaskTelemetry.METRICS.TASK.TOKENS_OUTPUT_TOTAL, value, attributes)
			this.emitter.recordHistogram(TaskTelemetry.METRICS.TASK.TOKENS_OUTPUT_PER_RESPONSE, value, attributes)
		}
		if (Number.isFinite(options?.cacheWriteTokens)) {
			const cacheWriteTokens = options!.cacheWriteTokens ?? 0
			this.emitter.recordCounter(TaskTelemetry.METRICS.CACHE.WRITE_TOTAL, cacheWriteTokens, attributes)
			this.emitter.recordHistogram(TaskTelemetry.METRICS.CACHE.WRITE_PER_EVENT, cacheWriteTokens, attributes)
		}
		if (Number.isFinite(options?.cacheReadTokens)) {
			const cacheReadTokens = options!.cacheReadTokens ?? 0
			this.emitter.recordCounter(TaskTelemetry.METRICS.CACHE.READ_TOTAL, cacheReadTokens, attributes)
			this.emitter.recordHistogram(TaskTelemetry.METRICS.CACHE.READ_PER_EVENT, cacheReadTokens, attributes)
		}
		if (Number.isFinite(options?.totalCost)) {
			const totalCost = options!.totalCost ?? 0
			const costAttributes = { ...attributes, currency: "USD" }
			this.emitter.recordCounter(TaskTelemetry.METRICS.TASK.COST_TOTAL, totalCost, costAttributes)
			this.emitter.recordHistogram(TaskTelemetry.METRICS.TASK.COST_PER_EVENT, totalCost, costAttributes)
		}
	}

	captureModeSwitch(ulid: string, mode: Mode): void {
		this.emitter.capture({ event: TaskTelemetry.EVENTS.MODE_SWITCH, properties: { ulid, mode } })
	}

	captureCondense(
		ulid: string,
		modelId: string,
		provider: string,
		source: "automatic" | "user",
		currentTokens: number,
		maxContextWindow: number,
	): void {
		this.emitter.capture({
			event: TaskTelemetry.EVENTS.CONDENSE,
			properties: { ulid, modelId, provider, source, currentTokens, maxContextWindow },
		})
	}

	captureTaskFeedback(ulid: string, feedbackType: TaskFeedbackType): void {
		Logger.info("TelemetryService: Capturing task feedback", { ulid, feedbackType })
		this.emitter.capture({ event: TaskTelemetry.EVENTS.FEEDBACK, properties: { ulid, feedbackType } })
		this.sessionTracker.resetAggregates(ulid)
	}

	captureTaskInitialization(ulid: string, taskId: string, durationMs: number, hasCheckpoints: boolean): void {
		this.emitter.capture({
			event: TaskTelemetry.EVENTS.INITIALIZATION,
			properties: { ulid, taskId, durationMs, hasCheckpoints },
		})
	}

	captureOptionSelected(ulid: string, qty: number, mode: Mode): void {
		this.emitter.capture({ event: TaskTelemetry.EVENTS.OPTION_SELECTED, properties: { ulid, qty, mode } })
	}

	captureOptionsIgnored(ulid: string, qty: number, mode: Mode): void {
		this.emitter.capture({ event: TaskTelemetry.EVENTS.OPTIONS_IGNORED, properties: { ulid, qty, mode } })
	}

	captureSlashCommandUsed(ulid: string, commandName: string, commandType: "builtin" | "workflow" | "skill"): void {
		this.emitter.capture({
			event: TaskTelemetry.EVENTS.SLASH_COMMAND_USED,
			properties: { ulid, commandName, commandType },
		})
	}

	captureFeatureToggle(ulid: string, featureName: string, enabled: boolean, modelId: string): void {
		this.emitter.capture({
			event: TaskTelemetry.EVENTS.FEATURE_TOGGLED,
			properties: { ulid, featureName, enabled, modelId },
		})
	}

	captureDiracRuleToggled(ulid: string, ruleFileName: string, enabled: boolean, isGlobal: boolean): void {
		// Sanitize filename to remove any path information for privacy
		const sanitizedFileName = ruleFileName.split("/").pop() || ruleFileName.split("\\").pop() || ruleFileName
		this.emitter.capture({
			event: TaskTelemetry.EVENTS.RULE_TOGGLED,
			properties: { ulid, ruleFileName: sanitizedFileName, enabled, isGlobal },
		})
	}

	captureAutoCondenseToggle(ulid: string, enabled: boolean, modelId: string): void {
		this.emitter.capture({
			event: TaskTelemetry.EVENTS.AUTO_CONDENSE_TOGGLED,
			properties: { ulid, enabled, modelId },
		})
	}

	captureYoloModeToggle(ulid: string, enabled: boolean): void {
		this.emitter.capture({ event: TaskTelemetry.EVENTS.YOLO_MODE_TOGGLED, properties: { ulid, enabled } })
	}

	captureDiracWebToolsToggle(ulid: string, enabled: boolean): void {
		this.emitter.capture({ event: TaskTelemetry.EVENTS.CLINE_WEB_TOOLS_TOGGLED, properties: { ulid, enabled } })
	}
}
