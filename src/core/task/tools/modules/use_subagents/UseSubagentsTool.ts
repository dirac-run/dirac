import { IDiracTool } from "../../interfaces/IDiracTool"
import { IToolEnvironment } from "../../interfaces/IToolEnvironment"
import { DiracToolSpec, DiracDefaultTool } from "@/shared/tools"
import { stripHashes } from "../../../../../shared/utils/line-hashing"
import { formatResponse } from "@core/formatResponse"
import { AgentConfigLoader } from "../../subagent/AgentConfigLoader"
import { SubagentStatusItem } from "@shared/ExtensionMessage"
import { excerpt } from "../../../utils/excerpt"
import { CardStatus } from "@shared/ExtensionMessage"
import { DiracIcon } from "@/shared/icons"

interface SubagentRequest {
	prompt: string
	timeout: number
	maxTurns?: number
	includeHistory: boolean
}

export const use_subagents_spec: DiracToolSpec = {
	id: DiracDefaultTool.USE_SUBAGENTS,
	name: "use_subagents",
	description: "Run subagents in parallel.",
	contextRequirements: (context) => context.subagentsEnabled === true,
	parameters: [
		{
			name: "subagents",
			type: "array",
			required: true,
			instruction: "Subagents to run in parallel.",
			items: {
				type: "object",
				properties: {
					prompt: {
						type: "string",
						description: "Task for this subagent.",
					},
					timeout: {
						type: "integer",
						description: "Timeout in seconds. Default: 300.",
					},
					max_turns: {
						type: "integer",
						description: "Maximum turns.",
					},
					include_history: {
						type: "boolean",
						description: "Include the main task conversation history.",
					},
				},
				required: ["prompt"],
				additionalProperties: false,
			},
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
		const requests = this.resolveRequests(args, subagentName)

		if (requests.length === 0) {
			env.orchestration.setTaskState(
				"consecutiveMistakeCount",
				env.orchestration.getTaskState("consecutiveMistakeCount") + 1,
			)
			return formatResponse.toolError(`Missing required parameter: ${subagentName ? "prompt" : "subagents"}`)
		}

		const entries = this.initializeEntries(requests.map(({ prompt }) => prompt))

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
					status:
						status === "running" ? CardStatus.RUNNING : status === "failed" ? CardStatus.ERROR : CardStatus.SUCCESS,
					body: this.formatSubagentStatusMarkdown(payload),
					renderType: "markdown",
				})
			}
		}

		await emitStatus("running", true)

		await this.runSubagents(requests, subagentName, entries, env, emitStatus)

		const failures = entries.filter((e) => e.status === "failed").length
		if (card) {
			await card.update({
				header: `Ran ${requests.length} subagents`,
			})
			await card.finalize(failures > 0 ? CardStatus.ERROR : CardStatus.SUCCESS)
		}
		await emitStatus(failures > 0 ? "failed" : "completed", false)

		const summary = this.formatFinalResponse(entries, failures)
		return formatResponse.toolResult(summary)
	}

	private validateExecution(env: IToolEnvironment): void {
		if (env.config.isSubagentExecution) {
			throw new Error("Subagents cannot spawn other subagents.")
		}
	}

	private resolveRequests(args: any, subagentName: string | undefined): SubagentRequest[] {
		if (subagentName) {
			const prompt = typeof args.prompt === "string" ? args.prompt.trim() : ""
			return prompt ? [{ prompt, ...this.parseOptions(args) }] : []
		}

		if (!Array.isArray(args.subagents)) {
			return []
		}

		return args.subagents.map((subagent: any, index: number) => {
			const prompt = typeof subagent?.prompt === "string" ? subagent.prompt.trim() : ""
			if (!prompt) {
				throw new Error(`Subagent ${index + 1} is missing required parameter: prompt`)
			}

			return { prompt, ...this.parseOptions(subagent) }
		})
	}

	private parseOptions(args: any): Omit<SubagentRequest, "prompt"> {
		return {
			timeout: args.timeout === undefined ? 300 : parseInt(String(args.timeout), 10),
			maxTurns: args.max_turns === undefined ? undefined : parseInt(String(args.max_turns), 10),
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
		requests: SubagentRequest[],
		subagentName: string | undefined,
		entries: SubagentStatusItem[],
		env: IToolEnvironment,
		emitStatus: (status: string, partial: boolean) => Promise<void>,
	): Promise<void> {
		const execution = requests.map(async (request, index) => {
			const subagentCard = !env.config.isSubagentExecution
				? await env.ui.createCard({
					header: `Subagent ${index + 1}: ${request.prompt.substring(0, 30)}...`,
					collapsed: true,
					status: CardStatus.RUNNING,
				})
				: undefined

			return env.orchestration.runSubagent(request.prompt, {
				timeout: request.timeout,
				maxTurns: request.maxTurns,
				includeHistory: request.includeHistory,
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
							status:
								update.status === "completed"
									? CardStatus.SUCCESS
									: update.status === "failed"
										? CardStatus.ERROR
										: CardStatus.RUNNING,
							body: stripHashes(update.result || update.error || current.latestToolCall || ""),
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

	private formatFinalResponse(entries: SubagentStatusItem[], failures: number): string {
		const totalToolCalls = entries.reduce((acc: number, e) => acc + (e.toolCalls || 0), 0)
		const maxContextTokens = entries.reduce((acc: number, e) => Math.max(acc, e.contextTokens || 0), 0)
		const contextWindow = entries.reduce((acc: number, e) => Math.max(acc, e.contextWindow || 0), 0)
		const maxContextUsagePercentage = entries.reduce((acc: number, e) => Math.max(acc, e.contextUsagePercentage || 0), 0)
		const totalCacheReads = entries.reduce((acc: number, e) => acc + (e.cacheReads || 0), 0)
		const totalCacheWrites = entries.reduce((acc, e) => acc + (e.cacheWrites || 0), 0)

		const summary = [
			"Subagent results:",
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
