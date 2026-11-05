import type { ModelProviderSelection } from "@shared/api"

export interface TaskletStartOptions {
	/** Assignment purpose, stored atomically with acceptance; not another execution path. */
	purpose?: "goal_verification"
	agentName?: string
	useUtilityModel?: boolean
	includeHistory?: boolean
	timeoutSeconds?: number
}

/** Durable delegation choices only; credentials always come from the current parent. */
export interface TaskletConfiguration {
	name?: string
	description?: string
	systemPrompt?: string
	skills?: string[]
	modelSelection?: ModelProviderSelection
	allowedTools?: string[]
	includeHistory: boolean
	timeoutSeconds: number
}

