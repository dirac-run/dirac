import type { DiracTool } from "@/shared/tools"
import { ensureBuiltinToolsRegistered } from "@core/task/tools/registry/refreshToolRegistry"
import type { ToolRequestSnapshot } from "@core/task/tools/runtime/ToolSnapshot"
import type { SystemPromptContext } from "../types"
import { PromptBuilder } from "./PromptBuilder"

export class PromptRegistry {
    private static instance: PromptRegistry
    public nativeTools: DiracTool[] | undefined = undefined

    private constructor() {
        ensureBuiltinToolsRegistered()
    }

    static getInstance(): PromptRegistry {
        if (!PromptRegistry.instance) {
            PromptRegistry.instance = new PromptRegistry()
        }
        return PromptRegistry.instance
    }

    /**
     * Get unified system prompt
     */
    async get(context: SystemPromptContext, toolSnapshot: ToolRequestSnapshot): Promise<string> {
        this.nativeTools = toolSnapshot.nativeTools

        const builder = new PromptBuilder(context)
        return await builder.build()
    }

    public static dispose(): void {
        PromptRegistry.instance = null as unknown as PromptRegistry
    }
}
