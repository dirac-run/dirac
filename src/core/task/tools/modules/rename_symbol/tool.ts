import type { IDiracTool } from "../../interfaces/IDiracTool"
import type { DiracToolSpec } from "@/shared/tools"
import { rename_symbol_spec, RenameSymbolTool } from "./RenameSymbolTool"

export const spec: DiracToolSpec = rename_symbol_spec

export function create(): IDiracTool {
	return new RenameSymbolTool()
}
