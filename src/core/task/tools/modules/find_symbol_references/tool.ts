import type { IDiracTool } from "../../interfaces/IDiracTool"
import type { DiracToolSpec } from "@/shared/tools"
import { find_symbol_references_spec, FindSymbolReferencesTool } from "./FindSymbolReferencesTool"

export const spec: DiracToolSpec = find_symbol_references_spec

export function create(): IDiracTool {
    return new FindSymbolReferencesTool()
}
