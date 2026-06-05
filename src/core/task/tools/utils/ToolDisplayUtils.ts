import { ToolParamName, ToolUse } from "@core/assistant-message"
import type { ToolExecutorCoordinator } from "../ToolExecutorCoordinator"
import { removeClosingTag } from "./ToolConstants"

/**
 * Utility functions for tool display and formatting
 */
export class ToolDisplayUtils {
	static getToolDescription(block: ToolUse, coordinator?: ToolExecutorCoordinator): string {
		return `[${block.name}]`
	}

	/**
	 * Remove partial closing tag from tool parameter text
	 * If block is partial, remove partial closing tag so it's not presented to user
	 */
	static removeClosingTag(block: ToolUse, tag: ToolParamName, text?: string): string {
		return removeClosingTag(block, tag, text)
	}
}
