import type { DiracTool } from "@/shared/tools"
import { ensureBuiltinToolsRegistered } from "@core/task/tools/registry/refreshToolRegistry"
import type { ToolRequestSnapshot } from "@core/task/tools/runtime/ToolSnapshot"
import type { SystemPromptContext } from "../types"
import { PromptBuilder } from "./PromptBuilder"

export class PromptRegistry {
    private static instance: PromptRegistry
    public nativeTools: DiracTool[] | undefined = undefined

    private cachedPrompt?: { fingerprint: string; result: string }

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

        const fingerprint = this.computePromptFingerprint(context, toolSnapshot)
        if (this.cachedPrompt?.fingerprint === fingerprint) {
            return this.cachedPrompt.result
        }

        const builder = new PromptBuilder(context)
        const result = await builder.build()
        this.cachedPrompt = { fingerprint, result }
        return result
    }

    private computePromptFingerprint(context: SystemPromptContext, toolSnapshot: ToolRequestSnapshot): string {
        return [
            // Tool snapshot — covers subagents, browser, multi-root, all contextRequirements-gated tools
            toolSnapshot.inventoryVersion,
            toolSnapshot.nativeTools.length,
            // Template text fields (template.ts)
            context.cwd,
            context.yoloModeToggled ? 1 : 0,
            context.enableParallelToolCalling ? 1 : 0,
            context.activeShellIsPosix ? 1 : 0,
            context.activeShellType,
            context.activeShellPath,
            // PromptBuilder placeholders
            context.availableCores,
            context.skills?.length ?? 0,
            // Instruction content lengths (length change → content change)
            context.preferredLanguageInstructions?.length ?? 0,
            context.diracIgnoreInstructions?.length ?? 0,
            context.globalDiracRulesFileInstructions?.length ?? 0,
            context.localDiracRulesFileInstructions?.length ?? 0,
            context.localCursorRulesFileInstructions?.length ?? 0,
            context.localCursorRulesDirInstructions?.length ?? 0,
            context.localWindsurfRulesFileInstructions?.length ?? 0,
            context.localAgentsRulesFileInstructions?.length ?? 0,
            context.userInstructions?.length ?? 0,
            context.diracRules?.length ?? 0,
        ].join(':')
    }

    public static dispose(): void {
        PromptRegistry.instance = null as unknown as PromptRegistry
    }
}
