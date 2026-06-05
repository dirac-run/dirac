import { buildApiHandler } from "@core/api"
import { DiracDefaultTool } from "@shared/tools"
import { ApiProvider } from "@/shared/api"
import { getProviderModelIdKey } from "@/shared/storage/provider-keys"
import type { TaskConfig } from "../types/TaskConfig"
import type { AgentBaseConfig } from "./AgentConfigLoader"
import { AgentConfigLoader } from "./AgentConfigLoader"

export type AgentConfig = Partial<AgentBaseConfig>

export const SUBAGENT_DEFAULT_ALLOWED_TOOLS: DiracDefaultTool[] = Object.values(DiracDefaultTool).filter(
    (tool) => tool !== DiracDefaultTool.USE_SUBAGENTS
)

export const SUBAGENT_SYSTEM_SUFFIX = `\n\n# Subagent Execution Mode
ou are running as a research subagent spawned by the main agent. Perform the requested task and report back.
You may use any tool at your disposal to accomplish the task. You may create and execute scripts or temporary files, but **do not modify or delete any pre-existing files**.
Call attempt_completion when finished or if you realize the task is not making any progress or otherwise ill suited to let main agent know. Focus on providing actionable information and relevant file paths.
`

export class SubagentBuilder {
    private readonly agentConfig: AgentConfig = {}
    private readonly allowedTools: string[]
    private readonly apiHandler: ReturnType<typeof buildApiHandler>

    constructor(
        private readonly baseConfig: TaskConfig,
        subagentName?: string,
    ) {
        const subagentConfig = AgentConfigLoader.getInstance().getCachedConfig(subagentName)
        this.agentConfig = subagentConfig ?? {}
        this.allowedTools = this.resolveAllowedTools(this.agentConfig.tools)

        const mode = this.baseConfig.services.stateManager.getGlobalSettingsKey("mode")
        const apiConfiguration = this.baseConfig.services.stateManager.getApiConfiguration()
        const effectiveApiConfiguration = {
            ...apiConfiguration,
            ulid: this.baseConfig.ulid,
        } as Record<string, unknown>
        this.applyModelOverride(effectiveApiConfiguration, mode, this.agentConfig.modelId)
        this.apiHandler = buildApiHandler(effectiveApiConfiguration as typeof apiConfiguration, mode)
    }

    getApiHandler(): ReturnType<typeof buildApiHandler> {
        return this.apiHandler
    }

    getAllowedTools(): string[] {
        return this.allowedTools
    }

    getConfiguredSkills(): string[] | undefined {
        return this.agentConfig.skills
    }

    buildSystemPrompt(generatedSystemPrompt: string): string {
        const configuredSystemPrompt = this.agentConfig?.systemPrompt?.trim()
        const systemPrompt = configuredSystemPrompt || generatedSystemPrompt
        return `${systemPrompt}${this.buildAgentIdentitySystemPrefix()}${SUBAGENT_SYSTEM_SUFFIX}`
    }

    private resolveAllowedTools(configuredTools?: string[]): string[] {
        const sourceTools = configuredTools && configuredTools.length > 0 ? configuredTools : SUBAGENT_DEFAULT_ALLOWED_TOOLS
        return Array.from(new Set([...sourceTools, DiracDefaultTool.ATTEMPT]))
    }

    private buildAgentIdentitySystemPrefix(): string {
        const name = this.agentConfig?.name?.trim()
        const description = this.agentConfig?.description?.trim()
        if (!name && !description) {
            return ""
        }

        const lines = ["# Agent Profile"]
        if (name) {
            lines.push(`Name: ${name}`)
        }
        if (description) {
            lines.push(`Description: ${description}`)
        }

        return `${lines.join("\n")}\n\n`
    }

    private applyModelOverride(apiConfiguration: Record<string, unknown>, _mode: string, modelId?: string): void {
        const trimmedModelId = modelId?.trim()
        if (!trimmedModelId) {
            return
        }

        const mode = _mode === "plan" ? "plan" : "act"
        const provider = apiConfiguration[_mode === "plan" ? "planModeApiProvider" : "actModeApiProvider"] as ApiProvider
        apiConfiguration[getProviderModelIdKey(provider as ApiProvider, mode)] = trimmedModelId
    }
}
