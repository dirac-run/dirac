/**
 * Tool response type — the content a tool returns to the task loop.
 * Re-exported from shared/messages so tools don't import from the task loop entry point.
 */
export type ToolResponse = import("@shared/messages").DiracToolResponseContent
