import { IDiracTool } from "../../interfaces/IDiracTool"
import { IToolEnvironment } from "../../interfaces/IToolEnvironment"
import { DiracToolSpec, DiracDefaultTool } from "@/shared/tools"
import { stripHashes } from "../../../../../shared/utils/line-hashing"
import { formatResponse } from "@core/prompts/responses"
import { AgentConfigLoader } from "../../subagent/AgentConfigLoader"
import { SubagentStatusItem } from "@shared/ExtensionMessage"
import { excerpt } from "../../../utils/excerpt"
import { CardStatus } from "@shared/ExtensionMessage"
import { DiracIcon } from "@/shared/icons"

export const use_subagents_spec: DiracToolSpec = {
    id: DiracDefaultTool.USE_SUBAGENTS,
    name: "use_subagents",
    description: "Run up to five focused in-process subagents in parallel.",
    contextRequirements: (context) => context.subagentsEnabled === true,
    parameters: [
        {
            name: "prompt_1",
            required: true,
            instruction: "First subagent prompt.",
        },
        {
            name: "prompt_2",
            required: false,
            instruction: "Second subagent prompt.",
        },
        {
            name: "prompt_3",
            required: false,
            instruction: "Optional third subagent prompt.",
        },
        {
            name: "prompt_4",
            required: false,
            instruction: "Optional fourth subagent prompt.",
        },
        {
            name: "prompt_5",
            required: false,
            instruction: "Optional fifth subagent prompt.",
        },
        {
            name: "timeout",
            required: false,
            instruction: "Optional timeout in seconds for each subagent. Defaults to 300 seconds.",
        },
        {
            name: "max_turns",
            required: false,
            instruction: "Optional maximum number of turns for each subagent.",
        },
        {
            name: "include_history",
            required: false,
            instruction: "Optional boolean to include the main task's conversation history.",
        },
    ],
}


export class UseSubagentsTool implements IDiracTool {
    spec(): DiracToolSpec {
        return use_subagents_spec
    }

    supportedSurfaces() {
        return ["all" as const]
    }

    async processCall(args: any, env: IToolEnvironment): Promise<any> {
        this.validateExecution(env)

        const subagentName = AgentConfigLoader.getInstance().resolveSubagentNameForTool(env.toolName)
        const prompts = this.resolvePrompts(args, subagentName)

        if (prompts.length === 0) {
            env.orchestration.setTaskState("consecutiveMistakeCount", env.orchestration.getTaskState("consecutiveMistakeCount") + 1)
            return formatResponse.toolError("Missing required parameter: prompt_1")
        }

        const options = this.parseOptions(args)
        const entries = this.initializeEntries(prompts)

        const card = !env.config.isSubagentExecution
            ? await env.ui.createCard({
                header: "Run Subagents",
                icon: DiracIcon.SUBAGENTS,
                collapsed: true,
            })
            : undefined

        const emitStatus = async (status: string, partial: boolean) => {
            const payload = this.calculateStatusPayload(status, entries)
            if (card) {
                await card.update({
                    status: status === "running" ? CardStatus.RUNNING : status === "failed" ? CardStatus.ERROR : CardStatus.SUCCESS,
                    body: this.formatSubagentStatusMarkdown(payload),
                    renderType: "markdown",
                })
            }
        }

        await emitStatus("running", true)

        await this.runSubagents(prompts, options, subagentName, entries, env, emitStatus)

        const failures = entries.filter((e) => e.status === "failed").length
        if (card) {
            await card.update({
                header: `Ran ${prompts.length} subagents`,
            })
            await card.finalize(failures > 0 ? CardStatus.ERROR : CardStatus.SUCCESS)
        }
        await emitStatus(failures > 0 ? "failed" : "completed", false)

        const summary = this.formatFinalResponse(entries, options, failures)
        return formatResponse.toolResult(summary)
    }

    private validateExecution(env: IToolEnvironment): void {
        if (env.config.isSubagentExecution) {
            throw new Error("Subagents cannot spawn other subagents.")
        }
    }

    private resolvePrompts(args: any, subagentName: string | undefined): string[] {
        return subagentName
            ? [args.prompt || args.prompt_1].map((p) => p?.trim()).filter((p): p is string => !!p)
            : ["prompt_1", "prompt_2", "prompt_3", "prompt_4", "prompt_5"]
                .map((key) => args[key]?.trim())
                .filter((p): p is string => !!p)
    }

    private parseOptions(args: any) {
        return {
            timeout: args.timeout ? parseInt(String(args.timeout), 10) : 300,
            maxTurns: args.max_turns ? parseInt(String(args.max_turns), 10) : undefined,
            includeHistory: args.include_history === true || String(args.include_history) === "true",
        }
    }

    private initializeEntries(prompts: string[]): SubagentStatusItem[] {
        return prompts.map((prompt, index) => ({
            index: index + 1,
            prompt,
            status: "pending",
            toolCalls: 0,
            inputTokens: 0,
            outputTokens: 0,
            cacheWrites: 0,
            cacheReads: 0,
            totalCost: 0,
            report: "",
            contextTokens: 0,
            contextWindow: 0,
            contextUsagePercentage: 0,
        }))
    }

    private calculateStatusPayload(status: string, entries: SubagentStatusItem[]): any {
        const completed = entries.filter((e) => e.status === "completed" || e.status === "failed").length
        const successes = entries.filter((e) => e.status === "completed").length
        const failures = entries.filter((e) => e.status === "failed").length
        const toolCalls = entries.reduce((acc: number, e) => acc + (e.toolCalls || 0), 0)
        const inputTokens = entries.reduce((acc: number, e) => acc + (e.inputTokens || 0), 0)
        const outputTokens = entries.reduce((acc: number, e) => acc + (e.outputTokens || 0), 0)
        const cacheWrites = entries.reduce((acc: number, e) => acc + (e.cacheWrites || 0), 0)
        const cacheReads = entries.reduce((acc: number, e) => acc + (e.cacheReads || 0), 0)
        const contextWindow = entries.reduce((acc: number, e) => Math.max(acc, e.contextWindow || 0), 0)
        const maxContextTokens = entries.reduce((acc: number, e) => Math.max(acc, e.contextTokens || 0), 0)
        const maxContextUsagePercentage = entries.reduce((acc: number, e) => Math.max(acc, e.contextUsagePercentage || 0), 0)

        return {
            status,
            total: entries.length,
            completed,
            successes,
            failures,
            toolCalls,
            inputTokens,
            outputTokens,
            cacheWrites,
            cacheReads,
            contextWindow,
            maxContextTokens,
            maxContextUsagePercentage,
            items: entries,
        }
    }

    private async runSubagents(
        prompts: string[],
        options: any,
        subagentName: string | undefined,
        entries: SubagentStatusItem[],
        env: IToolEnvironment,
        emitStatus: (status: string, partial: boolean) => Promise<void>,
    ): Promise<void> {
        const execution = prompts.map(async (prompt, index) => {
            const subagentCard = !env.config.isSubagentExecution ? await env.ui.createCard({
                header: `Subagent ${index + 1}: ${prompt.substring(0, 30)}...`,
                collapsed: true,
                status: CardStatus.RUNNING
            }) : undefined;

            return env.orchestration.runSubagent(prompt, {
                timeout: options.timeout,
                maxTurns: options.maxTurns,
                includeHistory: options.includeHistory,
                subagentName,
                onUpdate: async (update) => {
                    const current = entries[index]
                    if (update.status) current.status = update.status
                    if (update.result !== undefined) current.result = update.result
                    if (update.error !== undefined) current.error = update.error
                    if (update.latestToolCall !== undefined) current.latestToolCall = update.latestToolCall
                    if (update.stats) {
                        current.toolCalls = update.stats.toolCalls
                        current.inputTokens = update.stats.inputTokens
                        current.outputTokens = update.stats.outputTokens
                        current.cacheWrites = update.stats.cacheWriteTokens
                        current.cacheReads = update.stats.cacheReadTokens
                        current.totalCost = update.stats.totalCost
                        current.contextTokens = update.stats.contextTokens
                        current.contextWindow = update.stats.contextWindow
                        current.contextUsagePercentage = update.stats.contextUsagePercentage
                    }
                    await emitStatus("running", true)

                    if (subagentCard) {
                        await subagentCard.update({
                            status: update.status === "completed" ? CardStatus.SUCCESS : update.status === "failed" ? CardStatus.ERROR : CardStatus.RUNNING,
                            body: stripHashes(update.result || update.error || current.latestToolCall || "")
                        })
                    }
                },
            })
        })

        const results = await Promise.allSettled(execution)

        results.forEach((result, index) => {
            if (result.status === "rejected") {
                entries[index].status = "failed"
                entries[index].error = (result.reason as Error)?.message || "Subagent execution failed"
            } else {
                const val = result.value
                entries[index].status = val.status
                entries[index].result = val.result
                entries[index].error = val.error
                const stats = val.stats
                entries[index].toolCalls = stats.toolCalls
                entries[index].inputTokens = stats.inputTokens
                entries[index].outputTokens = stats.outputTokens
                entries[index].cacheWrites = stats.cacheWriteTokens
                entries[index].cacheReads = stats.cacheReadTokens
                entries[index].totalCost = stats.totalCost
                entries[index].contextTokens = stats.contextTokens
                entries[index].contextWindow = stats.contextWindow
                entries[index].contextUsagePercentage = stats.contextUsagePercentage
            }
        })
    }

    private formatFinalResponse(entries: SubagentStatusItem[], options: any, failures: number): string {
        const totalToolCalls = entries.reduce((acc: number, e) => acc + (e.toolCalls || 0), 0)
        const maxContextTokens = entries.reduce((acc: number, e) => Math.max(acc, e.contextTokens || 0), 0)
        const contextWindow = entries.reduce((acc: number, e) => Math.max(acc, e.contextWindow || 0), 0)
        const maxContextUsagePercentage = entries.reduce((acc: number, e) => Math.max(acc, e.contextUsagePercentage || 0), 0)
        const totalCacheReads = entries.reduce((acc: number, e) => acc + (e.cacheReads || 0), 0)
        const totalCacheWrites = entries.reduce((acc, e) => acc + (e.cacheWrites || 0), 0)

        const summary = [
            "Subagent results:",
            options.timeout ? `Timeout: ${options.timeout}s` : undefined,
            options.maxTurns ? `Max turns: ${options.maxTurns}` : undefined,
            `Total: ${entries.length}`,
            `Succeeded: ${entries.length - failures}`,
            `Failed: ${failures}`,
            `Tool calls: ${totalToolCalls}`,
            `Peak context usage: ${maxContextTokens.toLocaleString()} / ${contextWindow.toLocaleString()} (${maxContextUsagePercentage.toFixed(1)}%)`,
            `Cache: ${totalCacheReads.toLocaleString()} reads, ${totalCacheWrites.toLocaleString()} writes`,
            "",
            ...entries.map((e) => {
                const header = `[${e.index}] ${e.status.toUpperCase()} - ${e.prompt}`
                const detail = e.status === "completed" ? excerpt(e.result) : excerpt(e.error)
                return detail ? `${header}\n${detail}` : header
            }),
        ]
            .filter((line): line is string => line !== undefined)
            .join("\n")

        return summary
    }
    private formatSubagentStatusMarkdown(payload: any): string {
        let md = `### Subagent Status (${payload.completed}/${payload.total})\n\n`
        md += `| # | Status | Prompt | Tokens (In/Out) | Cost |\n`
        md += `|---|--------|--------|-----------------|------|\n`
        payload.items.forEach((item: SubagentStatusItem) => {
            const statusIcon = item.status === "completed" ? "✅" : item.status === "failed" ? "❌" : "⏳"
            const tokens = `${item.inputTokens.toLocaleString()} / ${item.outputTokens.toLocaleString()}`
            const cost = `$${item.totalCost.toFixed(4)}`
            md += `| ${item.index} | ${statusIcon} ${item.status} | ${item.prompt} | ${tokens} | ${cost} |\n`
        })
        md += `\n**Total Cost:** $${payload.items.reduce((acc: number, i: SubagentStatusItem) => acc + i.totalCost, 0).toFixed(4)}`
        return md
    }

}
