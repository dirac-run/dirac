/**
 * Browser action → ACP translation helpers.
 *
 * Browser action cards produced by BrowserActionTool use headers like
 * "Browser: launch https://example.com" and "Launch browser: https://example.com".
 * These don't match the existing TOOL_KIND_MAP keys in messageTranslator, so
 * this module provides a lookup that recognizes browser-action headers and maps
 * them to the ACP "execute" ToolKind.
 *
 * @module agent/browserActionTranslator
 */

import type * as acp from "@agentclientprotocol/sdk"

/**
 * Maps browser action names to ACP ToolKind values.
 * All browser actions map to "execute" since they are executable operations.
 */
export const BROWSER_ACTION_KIND_MAP: Record<string, acp.ToolKind> = {
	launch: "execute",
	click: "execute",
	type: "execute",
	scroll_down: "execute",
	scroll_up: "execute",
	close: "execute",
}

/**
 * Check whether a card header belongs to a browser action and return the
 * appropriate ACP ToolKind.
 *
 * BrowserActionTool emits headers in two forms:
 *   - "Browser: <action> [<detail>]"  (execution card)
 *   - "Launch browser: <url>"         (permission card for launch)
 *
 * @returns "execute" if the header matches, otherwise undefined.
 */
export function getBrowserActionKind(header: string): acp.ToolKind | undefined {
	if (header.startsWith("Browser:") || header.startsWith("Launch browser:")) {
		return "execute"
	}
	return undefined
}
