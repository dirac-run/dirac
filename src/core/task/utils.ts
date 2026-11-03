import { ApiHandler } from "@core/api"
import { execSync } from "child_process"
import { showSystemNotification } from "@/integrations/notifications"
import { DiracApiReqCancelReason, DiracApiReqInfo, DiracMessageType } from "@/shared/ExtensionMessage"
import { calculateApiCostAnthropic, calculateApiCostOpenAI, calculateApiCostQwen } from "@/utils/cost"
import { MessageStateHandler } from "./message-state"
import type { UsageMetricAvailability } from "./StreamingMetricsManager"

export const showNotificationForApproval = (message: string, notificationsEnabled: boolean) => {
	if (notificationsEnabled) {
		showSystemNotification({
			subtitle: "Approval Required",
			message,
		})
	}
}

type UpdateApiReqMsgParams = {
	messageStateHandler: MessageStateHandler
	lastApiReqIndex: number
	inputTokens: number
	reasoningTokens: number
	outputTokens: number
	cacheWriteTokens: number
	cacheReadTokens: number
	totalCost?: number
	usageAvailability?: UsageMetricAvailability
	api: ApiHandler
	cancelReason?: DiracApiReqCancelReason
	streamingFailedMessage?: string
	author?: string
	contextWindow?: number
	contextUsagePercentage?: number
	/** Move the current attempt into lifetime-only totals and clear live metrics atomically. */
	archiveForRetry?: boolean
}

export const calculateCost = (params: {
	inputTokens: number
	outputTokens: number
	cacheWriteTokens: number
	cacheReadTokens: number
	reasoningTokens: number
	api: ApiHandler
}): number | undefined => {
	if (params.api.shouldEstimateCost?.() === false) return undefined
	const info = params.api.getModel().info
	const provider = params.api.constructor.name
	if (provider === "ZAiHandler" || provider === "OpenAiHandler" || provider === "DeepSeekHandler") {
		return calculateApiCostOpenAI(
			info,
			params.inputTokens,
			params.outputTokens,
			params.cacheWriteTokens,
			params.cacheReadTokens,
			undefined,
			params.reasoningTokens,
		)
	}
	if (provider === "QwenHandler") {
		return calculateApiCostQwen(
			info,
			params.inputTokens,
			params.outputTokens,
			params.cacheWriteTokens,
			params.cacheReadTokens,
			undefined,
			params.reasoningTokens,
		)
	}
	return calculateApiCostAnthropic(
		info,
		params.inputTokens,
		params.outputTokens,
		params.cacheWriteTokens,
		params.cacheReadTokens,
		undefined,
		params.reasoningTokens,
	)
}

export const updateApiReqMsg = async (params: UpdateApiReqMsgParams) => {
	const diracMessages = params.messageStateHandler.getDiracMessages()
	const msg = diracMessages[params.lastApiReqIndex]
	if (!msg || msg.content.type !== DiracMessageType.API_STATUS) {
		throw new Error(`Message at index ${params.lastApiReqIndex} is not an api_status message`)
	}

	const currentApiReqInfo: DiracApiReqInfo = msg.content.status

	const cost =
		params.totalCost ??
		calculateCost({
			inputTokens: params.inputTokens,
			outputTokens: params.outputTokens,
			cacheWriteTokens: params.cacheWriteTokens,
			cacheReadTokens: params.cacheReadTokens,
			reasoningTokens: params.reasoningTokens,
			api: params.api,
		})
	const patch: Partial<DiracApiReqInfo> = {
		tokensIn: Math.max(params.inputTokens, currentApiReqInfo.tokensIn ?? 0),
		tokensOut: Math.max(params.outputTokens, currentApiReqInfo.tokensOut ?? 0),
		reasoningTokens: Math.max(params.reasoningTokens, currentApiReqInfo.reasoningTokens ?? 0),
		cacheWrites: Math.max(params.cacheWriteTokens, currentApiReqInfo.cacheWrites ?? 0),
		cacheReads: Math.max(params.cacheReadTokens, currentApiReqInfo.cacheReads ?? 0),
	}
	const deletions: (keyof DiracApiReqInfo)[] = ["retryStatus"]

	if (cost === undefined) deletions.push("cost")
	else patch.cost = cost
	if (params.usageAvailability) {
		patch.usageAvailability = { ...params.usageAvailability, cost: cost !== undefined }
	}
	if (params.cancelReason === undefined) deletions.push("cancelReason")
	else patch.cancelReason = params.cancelReason
	if (params.streamingFailedMessage === undefined) deletions.push("streamingFailedMessage")
	else patch.streamingFailedMessage = params.streamingFailedMessage
	if (params.contextWindow !== undefined) patch.contextWindow = params.contextWindow
	if (params.contextUsagePercentage !== undefined) patch.contextUsagePercentage = params.contextUsagePercentage

	if (params.archiveForRetry) {
		const archived = { ...currentApiReqInfo.deletedMetrics }
		for (const key of ["tokensIn", "tokensOut", "cacheWrites", "cacheReads", "cost", "reasoningTokens"] as const) {
			const value = patch[key]
			if (value !== undefined) archived[key] = (archived[key] ?? 0) + value
			patch[key] = 0
		}
		patch.deletedMetrics = archived
		patch.usageAvailability = { inputTokens: false, outputTokens: false, cacheWrites: false, cacheReads: false, reasoningTokens: false, cost: false }
		deletions.push("cost", "contextUsagePercentage")
	}

	await params.messageStateHandler.patchApiStatusById(msg.id, patch, deletions)
}

/**
 * Common CLI tools that developers frequently use
 */
const CLI_TOOLS = [
	"gh",
	"git",
	"docker",
	"podman",
	"kubectl",
	"care",
	"aws",
	"gcloud",
	"az",
	"terraform",
	"pulumi",
	"npm",
	"yarn",
	"pnpm",
	"pip",
	"cargo",
	"go",
	"curl",
	"jq",
	"make",
	"cmake",
	"python",
	"node",
	"psql",
	"mysql",
	"redis-cli",
	"sqlite3",
	"mongosh",
	"code",
	"grep",
	"sed",
	"awk",
	"brew",
	"apt",
	"yum",
	"gradle",
	"mvn",
	"bundle",
	"dotnet",
	"helm",
	"ansible",
	"wget",
]

/**
 * Detect which CLI tools are available in the system PATH
 * Uses 'which' command on Unix-like systems and 'where' on Windows
 */
export async function detectAvailableCliTools(): Promise<string[]> {
	const availableCommands: string[] = []
	const isWindows = process.platform === "win32"
	const checkCommand = isWindows ? "where" : "which"

	for (const command of CLI_TOOLS) {
		try {
			// Use execSync to check if the command exists
			execSync(`${checkCommand} ${command}`, {
				stdio: "ignore", // Don't output to console
				timeout: 1000, // 1 second timeout to avoid hanging
			})
			availableCommands.push(command)
		} catch (error) {
			// Command not found, skip it
		}
	}

	return availableCommands
}

/**
 * Extracts the domain from a provider URL string
 * @param url The URL to extract domain from
 * @returns The domain/hostname or undefined if invalid
 */
export function extractProviderDomainFromUrl(url: string | undefined): string | undefined {
	if (!url) {
		return undefined
	}
	try {
		const urlObj = new URL(url)
		return urlObj.hostname
	} catch {
		return undefined
	}
}
