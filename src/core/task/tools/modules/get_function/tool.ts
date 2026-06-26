import type { IDiracTool } from "../../interfaces/IDiracTool"
import type { DiracToolSpec } from "@/shared/tools"
import { get_function_spec, GetFunctionTool } from "./GetFunctionTool"

export const spec: DiracToolSpec = get_function_spec

export function create(): IDiracTool {
	return new GetFunctionTool()
}
