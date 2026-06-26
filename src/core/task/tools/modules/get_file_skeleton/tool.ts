import type { IDiracTool } from "../../interfaces/IDiracTool"
import type { DiracToolSpec } from "@/shared/tools"
import { get_file_skeleton_spec, GetFileSkeletonTool } from "./index"

export const spec: DiracToolSpec = get_file_skeleton_spec

export function create(): IDiracTool {
	return new GetFileSkeletonTool()
}
