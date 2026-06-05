import type { IDiracTool } from "../../interfaces/IDiracTool"
import type { DiracToolSpec } from "@/shared/tools"
import { report_bug_spec, ReportBugTool } from "./ReportBugTool"

export const spec: DiracToolSpec = report_bug_spec

export function create(): IDiracTool {
    return new ReportBugTool()
}
