import { StateManager } from "@core/storage/StateManager"
import { openAiCodexUsageService } from "@/integrations/openai-codex/OpenAiCodexUsageService"
import { githubCopilotAuthManager } from "@/integrations/github-copilot/auth"
import { getUnbiasedOAuthWorkloadName } from "@/integrations/unbiased/oauth-account"

/** Gathers provider authentication status and account identity for the UI. */
export async function assembleAuthState(stateManager: StateManager) {
	if (!StateManager.isInitialized()) {
		return {
			openAiCodexIsAuthenticated: undefined,
			openAiCodexEmail: undefined,
			openAiCodexUsage: undefined,
			githubCopilotIsAuthenticated: undefined,
			githubCopilotEmail: undefined,
			githubCopilotModels: undefined,
			unbiasedWorkloadName: null,
		}
	}

	const { openAiCodexOAuthManager } = await import("@/integrations/openai-codex/oauth")
	const githubCopilotModels = stateManager.getModelsCache("github-copilot") ?? undefined
	return {
		openAiCodexIsAuthenticated: await openAiCodexOAuthManager.isAuthenticated(),
		openAiCodexEmail: (await openAiCodexOAuthManager.getEmail()) ?? undefined,
		openAiCodexUsage: openAiCodexUsageService.getSnapshot(),
		githubCopilotIsAuthenticated: await githubCopilotAuthManager.isAuthenticated(),
		githubCopilotEmail: (await githubCopilotAuthManager.getEmail()) ?? undefined,
		githubCopilotModels,
		unbiasedWorkloadName: getUnbiasedOAuthWorkloadName(stateManager) ?? null,
	}
}
