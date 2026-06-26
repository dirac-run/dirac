import type { IDiracTool } from "../../interfaces/IDiracTool"
import type { DiracToolSpec } from "@/shared/tools"
import { replace_symbol_spec, ReplaceSymbolTool } from "./ReplaceSymbolTool"

export const spec: DiracToolSpec = replace_symbol_spec

export function create(): IDiracTool {
	return new ReplaceSymbolTool()
}
