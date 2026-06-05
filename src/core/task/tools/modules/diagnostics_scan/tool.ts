import type { IDiracTool } from "../../interfaces/IDiracTool"
import type { DiracToolSpec } from "@/shared/tools"
import { diagnostics_scan_spec, DiagnosticsScanTool } from "./index"

export const spec: DiracToolSpec = diagnostics_scan_spec

export function create(): IDiracTool {
    return new DiagnosticsScanTool()
}
