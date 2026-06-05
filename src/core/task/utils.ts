import { ApiHandler } from "@core/api"
import { execSync } from "child_process"
import { showSystemNotification } from "@/integrations/notifications"
import { DiracApiReqCancelReason, DiracApiReqInfo, DiracMessageType } from "@/shared/ExtensionMessage"

import { calculateApiCostAnthropic } from "@/utils/cost"
import { calculateApiCostOpenAI, calculateApiCostQwen } from "@/utils/cost"
import { MessageStateHandler } from "./message-state"

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
	api: ApiHandler
	cancelReason?: DiracApiReqCancelReason
	streamingFailedMessage?: string
	author?: string
	contextWindow?: number
	contextUsagePercentage?: number
}

export const calculateCost = (params: {
	inputTokens: number
	outputTokens: number
	cacheWriteTokens: number
	cacheReadTokens: number
	reasoningTokens: number
	api: ApiHandler
}): number => {
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
	delete currentApiReqInfo.retryStatus // Clear retry status when request is finalized

	await params.messageStateHandler.updateDiracMessage(params.lastApiReqIndex, {
		content: {
			type: DiracMessageType.API_STATUS,

			status: {
				...currentApiReqInfo, // Spread the modified info (with retryStatus removed)
				tokensIn: Math.max(params.inputTokens, currentApiReqInfo.tokensIn ?? 0),
				tokensOut: Math.max(params.outputTokens, currentApiReqInfo.tokensOut ?? 0),
				reasoningTokens: Math.max(params.reasoningTokens, currentApiReqInfo.reasoningTokens ?? 0),
				cacheWrites: Math.max(params.cacheWriteTokens, currentApiReqInfo.cacheWrites ?? 0),
				cacheReads: Math.max(params.cacheReadTokens, currentApiReqInfo.cacheReads ?? 0),
				cost:
					params.totalCost ??
					calculateCost({
						inputTokens: params.inputTokens,
						outputTokens: params.outputTokens,
						cacheWriteTokens: params.cacheWriteTokens,
						cacheReadTokens: params.cacheReadTokens,
						reasoningTokens: params.reasoningTokens,
						api: params.api,
					}),
				cancelReason: params.cancelReason,
				streamingFailedMessage: params.streamingFailedMessage,
				contextWindow: params.contextWindow ?? currentApiReqInfo.contextWindow,
				contextUsagePercentage: params.contextUsagePercentage ?? currentApiReqInfo.contextUsagePercentage,
			} satisfies DiracApiReqInfo,
		},
	})

	// Ensure UI is updated
	const updatedMsg = params.messageStateHandler.getDiracMessages()[params.lastApiReqIndex]
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
