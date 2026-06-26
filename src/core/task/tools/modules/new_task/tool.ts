import type { IDiracTool } from "../../interfaces/IDiracTool"
import type { DiracToolSpec } from "@/shared/tools"
import { new_task_spec, NewTaskTool } from "./NewTaskTool"

export const spec: DiracToolSpec = new_task_spec

export function create(): IDiracTool {
	return new NewTaskTool()
}
