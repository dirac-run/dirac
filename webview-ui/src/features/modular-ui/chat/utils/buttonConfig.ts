import { DiracAskResponse } from "@shared/WebviewMessage"
/**
 * Button action types that determine the behavior
 */
export type ButtonActionType =
	| DiracAskResponse.APPROVE // Send approve response
	| DiracAskResponse.REJECT // Send reject response
	| "proceed" // Send approve response
	| "new_task" // Start a new task
	| "cancel" // Cancel streaming
	| "utility" // Execute utility function (condense, report_bug)
	| DiracAskResponse.EDIT // Send edit response
	| DiracAskResponse.VIEW // Send view response
	| "retry" // Retry the last action

/**
 * Button configuration for different message states
 */

/**
 * Centralized button state configurations based on task lifecycle
 * This is the single source of truth for both button display and actions
 */
