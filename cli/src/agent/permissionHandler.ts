/**
 * Interaction handling for ACP integration.
 *
 * This module handles the translation between ACP interaction responses
 * and Dirac's internal interaction system.
 *
 * @module acp/interactionHandler
 */

import type * as acp from "@agentclientprotocol/sdk"
import { DiracAskResponse } from "@shared/WebviewMessage"

/**
 * Result of handling an interaction response.
 */
export interface InteractionHandlerResult {
	/** Dirac's internal response type */
	response: DiracAskResponse | string
	/** Optional text to pass with the response */
	text?: string
	/** Whether this decision should become a persisted permission rule. */
	persistentAction?: "allow" | "deny"
	/** Whether the request was cancelled */
	cancelled?: boolean
}

/**
 * Handle an ACP interaction response and translate it to Dirac's format.
 *
 * @param response - The ACP permission response from the client
 * @param interactionType - The type of interaction ("tool" for approvals, "followup" for feedback)
 * @returns The translated result for Dirac's handleWebviewAskResponse
 */
export function handlePermissionResponse(
	response: acp.RequestPermissionResponse,
	interactionType: "tool" | "followup",
): InteractionHandlerResult {
	// Check if cancelled
	if (response.outcome.outcome === "cancelled") {
		return {
			response: DiracAskResponse.REJECT,
			cancelled: true,
		}
	}

	// Get the selected option ID
	const optionId = response.outcome.optionId

	// Translate the option to Dirac's response format
	switch (optionId) {
		case DiracAskResponse.APPROVE:
		case "allow_once":
			return {
				response: DiracAskResponse.APPROVE,
			}

		case "allow_always":
			return {
				response: DiracAskResponse.APPROVE,
				persistentAction: "allow",
			}

		case DiracAskResponse.REJECT:
		case "reject_once":
			return {
				response: DiracAskResponse.REJECT,
			}

		case "reject_always":
			return {
				response: DiracAskResponse.REJECT,
				persistentAction: "deny",
			}

		case DiracAskResponse.MESSAGE:
			return {
				response: DiracAskResponse.MESSAGE,
				text: (response.outcome as any).data?.text as string | undefined,
			}

		default:
			return {
				response: optionId,
				text: (response.outcome as any).data?.text as string | undefined,
			}
	}
}
