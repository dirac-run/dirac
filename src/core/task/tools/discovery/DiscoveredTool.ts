import type { DiracToolSpec } from "@/shared/tools"
import type { IDiracTool } from "../interfaces/IDiracTool"
import type { TaskConfig } from "../types/TaskConfig"

export type ToolSource = "builtin" | "global" | "workspace"

export interface DiscoveredTool {
	/** Unique identifier (e.g., "say", "my_custom_tool") */
	id: string
	/** LLM-facing name (e.g., "say") */
	name: string
	/** Where this tool was discovered */
	source: ToolSource
	/** For LLM API schema generation */
	spec: DiracToolSpec
	/** For runtime instantiation */
	factory: (config?: TaskConfig) => IDiracTool
	/** Filesystem path to the tool.ts manifest */
	modulePath: string
}
