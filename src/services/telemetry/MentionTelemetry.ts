/**
 * Captures mention telemetry: successful mentions, failed mentions, and search results.
 * Extracted from TelemetryService to enforce SRP — mention-domain events are isolated from other domains.
 */
import { TELEMETRY_EVENTS } from "./TelemetryEvents"
import type { TelemetryEventEmitter } from "./TelemetryEventEmitter"

const MAX_ERROR_MESSAGE_LENGTH = 500

type MentionType = "file" | "folder" | "url" | "problems" | "terminal" | "git-changes" | "commit"

export class MentionTelemetry {
	private static readonly EVENTS = TELEMETRY_EVENTS.TASK

	constructor(private readonly emitter: TelemetryEventEmitter) {}

	captureMentionUsed(mentionType: MentionType, contentLength?: number): void {
		this.emitter.capture({
			event: MentionTelemetry.EVENTS.MENTION_USED,
			properties: { mentionType, contentLength, timestamp: new Date().toISOString() },
		})
	}

	captureMentionFailed(
		mentionType: MentionType,
		errorType: "not_found" | "permission_denied" | "network_error" | "parse_error" | "unknown",
		errorMessage?: string,
	): void {
		this.emitter.capture({
			event: MentionTelemetry.EVENTS.MENTION_FAILED,
			properties: {
				mentionType,
				errorType,
				errorMessage: errorMessage?.substring(0, MAX_ERROR_MESSAGE_LENGTH),
				timestamp: new Date().toISOString(),
			},
		})
	}

	captureMentionSearchResults(query: string, resultCount: number, searchType: "file" | "folder" | "all", isEmpty: boolean): void {
		this.emitter.capture({
			event: MentionTelemetry.EVENTS.MENTION_SEARCH_RESULTS,
			properties: {
				queryLength: query.length,
				resultCount,
				searchType,
				isEmpty,
				timestamp: new Date().toISOString(),
			},
		})
	}
}
