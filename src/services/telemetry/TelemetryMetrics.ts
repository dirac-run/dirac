/**
 * Telemetry metric name constants.
 * Extracted from TelemetryService to reduce class size.
 */
export const TELEMETRY_METRICS = {
	TASK: {
		TURNS_TOTAL: "dirac.turns.total",
		TURNS_PER_TASK: "dirac.turns.per_task",
		TOKENS_INPUT_TOTAL: "dirac.tokens.input.total",
		TOKENS_INPUT_PER_RESPONSE: "dirac.tokens.input.per_response",
		TOKENS_OUTPUT_TOTAL: "dirac.tokens.output.total",
		TOKENS_OUTPUT_PER_RESPONSE: "dirac.tokens.output.per_response",
		COST_TOTAL: "dirac.cost.total",
		COST_PER_EVENT: "dirac.cost.per_event",
	},
	CACHE: {
		WRITE_TOTAL: "dirac.cache.write.tokens.total",
		WRITE_PER_EVENT: "dirac.cache.write.tokens.per_event",
		READ_TOTAL: "dirac.cache.read.tokens.total",
		READ_PER_EVENT: "dirac.cache.read.tokens.per_event",
		HITS_TOTAL: "dirac.cache.hits.total",
	},
	TOOLS: {
		CALLS_TOTAL: "dirac.tool.calls.total",
		CALLS_PER_TASK: "dirac.tool.calls.per_task",
	},
	ERRORS: {
		TOTAL: "dirac.errors.total",
		PER_TASK: "dirac.errors.per_task",
	},
	API: {
		TTFT_SECONDS: "dirac.api.ttft.seconds",
		DURATION_SECONDS: "dirac.api.duration.seconds",
		THROUGHPUT_TOKENS_PER_SECOND: "dirac.api.throughput.tokens_per_second",
	},
	HOOKS: {
		EXECUTIONS_TOTAL: "dirac.hooks.executions.total",
		DURATION_SECONDS: "dirac.hooks.duration.seconds",
		FAILURES_TOTAL: "dirac.hooks.failures.total",
		CANCELLATIONS_TOTAL: "dirac.hooks.cancellations.total",
		CONTEXT_MODIFICATIONS_TOTAL: "dirac.hooks.context_modifications.total",
		CACHE_ACCESSES_TOTAL: "dirac.hooks.cache.accesses.total",
	},
	AI_OUTPUT: {
		ACCEPTED_LINES_ADDED: "dirac.ai_output.accepted.lines_added.total",
		ACCEPTED_LINES_DELETED: "dirac.ai_output.accepted.lines_deleted.total",
		ACCEPTED_LINES_CHANGED: "dirac.ai_output.accepted.lines_changed.total",
		ACCEPTED_FILES_CREATED: "dirac.ai_output.accepted.files_created.total",
		ACCEPTED_FILES_DELETED: "dirac.ai_output.accepted.files_deleted.total",
		ACCEPTED_FILES_MOVED: "dirac.ai_output.accepted.files_moved.total",
		REJECTED_LINES_ADDED: "dirac.ai_output.rejected.lines_added.total",
		REJECTED_LINES_DELETED: "dirac.ai_output.rejected.lines_deleted.total",
		REJECTED_LINES_CHANGED: "dirac.ai_output.rejected.lines_changed.total",
		REJECTED_FILES_CREATED: "dirac.ai_output.rejected.files_created.total",
		REJECTED_FILES_DELETED: "dirac.ai_output.rejected.files_deleted.total",
		REJECTED_FILES_MOVED: "dirac.ai_output.rejected.files_moved.total",
	},
	GRPC: {
		RESPONSE_SIZE_BYTES: "dirac.grpc.response.size_bytes",
	},
}
