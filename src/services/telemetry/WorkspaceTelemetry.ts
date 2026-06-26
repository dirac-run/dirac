/**
 * Captures workspace and worktree telemetry: initialization, multi-root checkpoints, path resolution,
 * search patterns, and worktree lifecycle.
 * Extracted from TelemetryService to enforce SRP — workspace-domain events are isolated from other domains.
 */
import { TELEMETRY_EVENTS } from "./TelemetryEvents"
import type { TelemetryEventEmitter } from "./TelemetryEventEmitter"

const MAX_ERROR_MESSAGE_LENGTH = 500

export class WorkspaceTelemetry {
	private static readonly EVENTS = { ...TELEMETRY_EVENTS.WORKSPACE, TASK: TELEMETRY_EVENTS.TASK, WORKTREE: TELEMETRY_EVENTS.WORKTREE }

	constructor(private readonly emitter: TelemetryEventEmitter) {}

	captureWorkspaceInitialized(
		rootCount: number,
		vcsTypes: string[],
		initDurationMs?: number,
		featureFlagEnabled?: boolean,
	): void {
		this.emitter.capture({
			event: WorkspaceTelemetry.EVENTS.INITIALIZED,
			properties: {
				root_count: rootCount,
				vcs_types: vcsTypes,
				is_multi_root: rootCount > 1,
				has_git: vcsTypes.includes("Git"),
				has_mercurial: vcsTypes.includes("Mercurial"),
				init_duration_ms: initDurationMs,
				feature_flag_enabled: featureFlagEnabled,
			},
		})
		const isMultiRoot = rootCount > 1
		this.emitter.recordGauge("dirac.workspace.active_roots", rootCount, { is_multi_root: isMultiRoot })
		// Retire the previous series to avoid leaking gauge entries when the flag flips.
		this.emitter.recordGauge("dirac.workspace.active_roots", null, { is_multi_root: !isMultiRoot })
	}

	captureWorkspaceInitError(error: Error, fallbackMode: boolean, workspaceCount?: number): void {
		this.emitter.capture({
			event: WorkspaceTelemetry.EVENTS.INIT_ERROR,
			properties: {
				error_type: error.constructor.name,
				error_message: error.message.substring(0, MAX_ERROR_MESSAGE_LENGTH),
				fallback_to_single_root: fallbackMode,
				workspace_count: workspaceCount ?? 0,
			},
		})
	}

	captureMultiRootCheckpoint(
		ulid: string,
		action: "initialized" | "committed" | "restored",
		rootCount: number,
		successCount: number,
		failureCount: number,
		durationMs?: number,
	): void {
		this.emitter.capture({
			event: WorkspaceTelemetry.EVENTS.MULTI_ROOT_CHECKPOINT,
			properties: {
				ulid,
				action,
				root_count: rootCount,
				success_count: successCount,
				failure_count: failureCount,
				success_rate: rootCount > 0 ? successCount / rootCount : 0,
				duration_ms: durationMs,
			},
		})
	}

	captureWorkspacePathResolved(
		ulid: string,
		context: string,
		resolutionType: "hint_provided" | "fallback_to_primary" | "cross_workspace_search",
		hintType?: "workspace_name" | "workspace_path" | "invalid",
		resolutionSuccess?: boolean,
		targetWorkspaceIndex?: number,
		isMultiRootEnabled?: boolean,
	): void {
		this.emitter.capture({
			event: WorkspaceTelemetry.EVENTS.PATH_RESOLVED,
			properties: {
				ulid,
				context,
				resolution_type: resolutionType,
				hint_type: hintType,
				resolution_success: resolutionSuccess,
				target_workspace_index: targetWorkspaceIndex,
				is_multi_root_enabled: isMultiRootEnabled,
			},
		})
	}

	captureWorkspaceSearchPattern(
		ulid: string,
		searchType: "targeted" | "cross_workspace" | "primary_only",
		workspaceCount: number,
		hintProvided: boolean,
		resultsFound: boolean,
		searchDurationMs?: number,
	): void {
		this.emitter.capture({
			event: WorkspaceTelemetry.EVENTS.TASK.WORKSPACE_SEARCH_PATTERN,
			properties: {
				ulid,
				search_type: searchType,
				workspace_count: workspaceCount,
				hint_provided: hintProvided,
				results_found: resultsFound,
				search_duration_ms: searchDurationMs,
			},
		})
	}

	captureWorktreeViewOpened(source: "home_page" | "menu_bar"): void {
		this.emitter.capture({ event: WorkspaceTelemetry.EVENTS.WORKTREE.VIEW_OPENED, properties: { source } })
	}

	captureWorktreeCreated(success: boolean, worktreeCount?: number): void {
		this.emitter.capture({
			event: WorkspaceTelemetry.EVENTS.WORKTREE.CREATED,
			properties: { success, worktree_count: worktreeCount },
		})
	}

	captureWorktreeMergeAttempted(success: boolean, hasConflicts: boolean, deleteAfterMerge: boolean): void {
		this.emitter.capture({
			event: WorkspaceTelemetry.EVENTS.WORKTREE.MERGE_ATTEMPTED,
			properties: { success, has_conflicts: hasConflicts, delete_after_merge: deleteAfterMerge },
		})
	}
}
