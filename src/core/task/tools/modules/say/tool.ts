import type { IDiracTool } from "../../interfaces/IDiracTool"
import type { DiracToolSpec } from "@/shared/tools"
import { say_spec, SayTool } from "./SayTool"

export const spec: DiracToolSpec = say_spec

export function create(): IDiracTool {
	return new SayTool()
}
