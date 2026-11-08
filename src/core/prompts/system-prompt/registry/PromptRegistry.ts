import type { ToolRequestSnapshot } from "@core/task/tools/runtime/ToolSnapshot"
import type { DiracTool } from "@/shared/tools"
import type { SystemPromptContext } from "../types"
import { PromptBuilder } from "./PromptBuilder"

export class PromptRegistry {
	private static instance: PromptRegistry
	public nativeTools: DiracTool[] | undefined = undefined

	private constructor() { }

	static getInstance(): PromptRegistry {
		if (!PromptRegistry.instance) PromptRegistry.instance = new PromptRegistry()
		return PromptRegistry.instance
	}

	async get(context: SystemPromptContext, toolSnapshot: ToolRequestSnapshot): Promise<string> {
		this.nativeTools = toolSnapshot.nativeTools
		// Transcript ownership is task-local. A process-global cache keyed by lengths
		// can return another task's instructions or hide same-length rule changes.
		return new PromptBuilder(context).build()
	}

	public static dispose(): void {
		PromptRegistry.instance = null as unknown as PromptRegistry
	}
}
