import { fetch } from "@/shared/net"
import { z } from "zod"
import { ModelInfo, openAiModelInfoSaneDefaults } from "@shared/api"

export const GITHUB_COPILOT_BASE_URL = "https://api.githubcopilot.com"
export const GITHUB_TOKEN_EXCHANGE_URL = "https://api.github.com/copilot_internal/v2/token"

export interface CopilotTokenResponse {
	token: string
	expires_at: number
}

export const githubCopilotModelSchema = z.object({
	data: z.array(
		z.object({
			model_picker_enabled: z.boolean().optional(),
			id: z.string(),
			name: z.string(),
			version: z.string(),
			supported_endpoints: z.array(z.string()).optional(),
			policy: z
				.object({
					state: z.string().optional(),
				})
				.optional(),
			capabilities: z.object({
				family: z.string(),
				limits: z.object({
					max_context_window_tokens: z.number(),
					max_output_tokens: z.number(),
					max_prompt_tokens: z.number().optional(),
					vision: z
						.object({
							max_prompt_image_size: z.number(),
							max_prompt_images: z.number(),
							supported_media_types: z.array(z.string()),
						})
						.optional(),
				}),
				supports: z.object({
					adaptive_thinking: z.boolean().optional(),
					max_thinking_budget: z.number().optional(),
					min_thinking_budget: z.number().optional(),
					reasoning_effort: z.array(z.string()).optional(),
					streaming: z.boolean(),
					structured_outputs: z.boolean().optional(),
					tool_calls: z.boolean(),
					vision: z.boolean().optional(),
				}),
			}),
		}),
	),
})

export const COPILOT_SPOOF_HEADERS = {
	"Editor-Version": "vscode/1.95.3",
	"Editor-Plugin-Version": "copilot-chat/0.22.2",
	"User-Agent": "GitHubCopilotChat/0.22.2",
	"x-github-api-version": "2023-07-07",
	"x-initiator": "user",
}

let cachedCopilotToken: CopilotTokenResponse | null = null

export async function getCopilotToken(githubToken: string): Promise<string> {
	const now = Math.floor(Date.now() / 1000)
	if (cachedCopilotToken && cachedCopilotToken.expires_at > now + 60) {
		return cachedCopilotToken.token
	}

	const response = await fetch(GITHUB_TOKEN_EXCHANGE_URL, {
		headers: {
			Authorization: `token ${githubToken}`,
			"User-Agent": "Dirac-CLI/1.0.0",
		},
	})

	if (!response.ok) {
		const errorText = await response.text()
		throw new Error(`Failed to exchange GitHub token for Copilot token: ${response.status} - ${errorText}`)
	}

	const data = (await response.json()) as CopilotTokenResponse
	cachedCopilotToken = data
	return data.token
}

export async function fetchCopilotModels(token: string) {
	const response = await fetch(`${GITHUB_COPILOT_BASE_URL}/models`, {
		headers: {
			Authorization: `Bearer ${token}`,
			...COPILOT_SPOOF_HEADERS,
		},
	})

	if (!response.ok) {
		throw new Error(`Failed to fetch models: ${response.statusText}`)
	}

	const data = await response.json()
	const validModels = data.data.filter((m: any) => m.policy?.state !== "disabled")
	const parsedModels = []
	for (const m of validModels) {
		const result = githubCopilotModelSchema.shape.data.element.safeParse(m)
		if (result.success) {
			parsedModels.push(result.data)
		} else {
			// Logger.warn(`[github-copilot] Skipping model ${m.id} due to schema mismatch: ${result.error.message}`)
		}
	}
	return parsedModels
}

export function transformCopilotModelToModelInfo(rawModel: z.infer<typeof githubCopilotModelSchema>["data"][0]): ModelInfo {
	return {
		...openAiModelInfoSaneDefaults,
		name: rawModel.name,
		contextWindow: rawModel.capabilities.limits.max_context_window_tokens,
		maxTokens: rawModel.capabilities.limits.max_output_tokens,
		supportsTools: rawModel.capabilities.supports.tool_calls,
		supportsImages: rawModel.capabilities.supports.vision,
		description: `GitHub Copilot: ${rawModel.name}`,
		thinkingConfig: rawModel.capabilities.supports.max_thinking_budget
			? {
					maxBudget: rawModel.capabilities.supports.max_thinking_budget,
				}
			: undefined,
	}
}
