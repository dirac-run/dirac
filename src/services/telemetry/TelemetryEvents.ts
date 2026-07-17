/**
 * Telemetry event name constants for tracking user interactions and system events.
 * Extracted from TelemetryService to reduce class size.
 */
export const TELEMETRY_EVENTS = {
	// Task-related events for tracking conversation and execution flow

	USER: {
		OPT_OUT: "user.opt_out",
		OPT_IN: "user.opt_in",
		TELEMETRY_ENABLED: "user.telemetry_enabled",
		EXTENSION_ACTIVATED: "user.extension_activated",
		EXTENSION_STORAGE_ERROR: "user.extension_storage_error",
		AUTH_STARTED: "user.auth_started",
		AUTH_SUCCEEDED: "user.auth_succeeded",
		AUTH_FAILED: "user.auth_failed",
		AUTH_LOGGED_OUT: "user.auth_logged_out",
		ONBOARDING_PROGRESS: "user.onboarding_progress",
	},
	// Workspace-related events for multi-root support
	WORKSPACE: {
		// Track workspace initialization
		INITIALIZED: "workspace.initialized",
		// Track initialization errors
		INIT_ERROR: "workspace.init_error",
		// Track VCS detection
		VCS_DETECTED: "workspace.vcs_detected",
		// Track multi-root checkpoint operations
		MULTI_ROOT_CHECKPOINT: "workspace.multi_root_checkpoint",
		// Track workspace resolution
		PATH_RESOLVED: "workspace.path_resolved",
	},
	TASK: {
		// Tracks when a new task/conversation is started
		CREATED: "task.created",
		// Tracks when a task is reopened
		RESTARTED: "task.restarted",
		// Tracks when a task is finished, with acceptance or rejection status
		COMPLETED: "task.completed",
		// Tracks user feedback on completed tasks
		FEEDBACK: "task.feedback",
		// Tracks when a message is sent in a conversation
		CONVERSATION_TURN: "task.conversation_turn",
		// Tracks token consumption for cost and usage analysis
		TOKEN_USAGE: "task.tokens",
		// Tracks switches between plan and act modes
		MODE_SWITCH: "task.mode",
		// Tracks when users select an option from AI-generated followup questions
		OPTION_SELECTED: "task.option_selected",
		// Tracks when users type a custom response instead of selecting an option from AI-generated followup questions
		OPTIONS_IGNORED: "task.options_ignored",
		// Tracks usage of the git-based checkpoint system (shadow_git_initialized, commit_created, branch_created, branch_deleted_active, branch_deleted_inactive, restored)
		CHECKPOINT_USED: "task.checkpoint_used",
		// Tracks when tools (like file operations, commands) are used
		TOOL_USED: "task.tool_used",
		// Tracks when a historical task is loaded from storage
		HISTORICAL_LOADED: "task.historical_loaded",
		// Tracks when the retry button is clicked for failed operations
		RETRY_CLICKED: "task.retry_clicked",
		// Tracks when a diff edit (replace_in_file) operation fails

		// Tracks when the browser tool is started
		BROWSER_TOOL_START: "task.browser_tool_start",
		// Tracks when the browser tool is completed
		BROWSER_TOOL_END: "task.browser_tool_end",
		// Tracks when browser errors occur
		BROWSER_ERROR: "task.browser_error",
		// Tracks Gemini API specific performance metrics
		GEMINI_API_PERFORMANCE: "task.gemini_api_performance",
		// Tracks when API providers return errors
		PROVIDER_API_ERROR: "task.provider_api_error",
		// Tracks conversation compaction, including whether it was automatic or user-requested.
		CONDENSE: "task.condense",
		// Tracks when slash commands or workflows are activated
		SLASH_COMMAND_USED: "task.slash_command_used",
		// Tracks when a feature is toggled on/off
		FEATURE_TOGGLED: "task.feature_toggled",
		// Tracks when individual Dirac rules are toggled on/off
		RULE_TOGGLED: "task.rule_toggled",
		// Tracks when auto condense setting is toggled on/off
		AUTO_CONDENSE_TOGGLED: "task.auto_condense_toggled",
		// Tracks when yolo mode setting is toggled on/off
		YOLO_MODE_TOGGLED: "task.yolo_mode_toggled",
		// Tracks when Dirac web tools setting is toggled on/off
		CLINE_WEB_TOOLS_TOGGLED: "task.dirac_web_tools_toggled",
		// Tracks task initialization timing
		INITIALIZATION: "task.initialization",
		// Terminal execution telemetry events
		TERMINAL_EXECUTION: "task.terminal_execution",
		TERMINAL_OUTPUT_FAILURE: "task.terminal_output_failure",
		TERMINAL_USER_INTERVENTION: "task.terminal_user_intervention",
		TERMINAL_HANG: "task.terminal_hang",
		// Mention telemetry events
		MENTION_USED: "task.mention_used",
		MENTION_FAILED: "task.mention_failed",
		MENTION_SEARCH_RESULTS: "task.mention_search_results",
		// Multi-workspace search pattern tracking
		WORKSPACE_SEARCH_PATTERN: "task.workspace_search_pattern",
		// CLI Subagents telemetry events
		SUBAGENT_ENABLED: "task.subagent_enabled",
		SUBAGENT_DISABLED: "task.subagent_disabled",
		SUBAGENT_STARTED: "task.subagent_started",
		SUBAGENT_COMPLETED: "task.subagent_completed",
		// Skills telemetry events
		SKILL_USED: "task.skill_used",
	},
	// UI interaction events for tracking user engagement
	UI: {
		// Tracks when a different model is selected
		MODEL_SELECTED: "ui.model_selected",
		// Tracks when users use the "favorite" button in the model picker
		MODEL_FAVORITE_TOGGLED: "ui.model_favorite_toggled",
		// Tracks when a button is clicked
		BUTTON_CLICKED: "ui.button_clicked",
		// Tracks when the rules menu button is clicked
		RULES_MENU_OPENED: "ui.rules_menu_opened",
	},
	// Hooks-related events for tracking hook execution
	HOOKS: {
		// Tracks when hooks feature is enabled
		ENABLED: "hooks.enabled",
		// Tracks when hooks feature is disabled
		DISABLED: "hooks.disabled",
		// Tracks when a hook requests task cancellation
		CANCEL_REQUESTED: "hooks.cancel_requested",
		// Tracks when a hook modifies context
		CONTEXT_MODIFIED: "hooks.context_modified",
		// Tracks when hook discovery completes
		DISCOVERY_COMPLETED: "hooks.discovery_completed",
	},
	// Worktree-related events for tracking worktree feature usage
	WORKTREE: {
		// Tracks when user opens worktrees view from home page
		VIEW_OPENED: "worktree.view_opened",
		// Tracks when a worktree is created
		CREATED: "worktree.created",
		// Tracks when a worktree merge is attempted
		MERGE_ATTEMPTED: "worktree.merge_attempted",
	},
	HOST: {
		// Tracks events detected from the host environment
		DETECTED: "host.detected",
	},
}
