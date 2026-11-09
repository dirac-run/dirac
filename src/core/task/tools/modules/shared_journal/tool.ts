import type { ToolExposure } from "../../discovery/ToolExposure"
import type { IDiracTool } from "../../interfaces/IDiracTool"
import { SharedJournalTool, shared_journal_spec } from "./SharedJournalTool"

export const spec = shared_journal_spec
export const exposure: ToolExposure = { kind: "context_only" }

export function create(): IDiracTool { return new SharedJournalTool() }
