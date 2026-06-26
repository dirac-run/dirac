import { StateManager } from "@core/storage/StateManager"
import { githubCopilotAuthManager } from "@/integrations/github-copilot/auth"

/** Gathers OAuth/auth status for OpenAI Codex and GitHub Copilot integrations. */
export async function assembleAuthState(stateManager: StateManager) {
	if (!StateManager.isInitialized()) {
		return {
			openAiCodexIsAuthenticated: undefined,
			openAiCodexEmail: undefined,
			githubCopilotIsAuthenticated: undefined,
			githubCopilotEmail: undefined,
			githubCopilotModels: undefined,
		}
	}

	const { openAiCodexOAuthManager } = await import("@/integrations/openai-codex/oauth")
	const githubCopilotModels = stateManager.getModelsCache("github-copilot") ?? undefined
	return {
		openAiCodexIsAuthenticated: await openAiCodexOAuthManager.isAuthenticated(),
		openAiCodexEmail: (await openAiCodexOAuthManager.getEmail()) ?? undefined,
		githubCopilotIsAuthenticated: await githubCopilotAuthManager.isAuthenticated(),
		githubCopilotEmail: (await githubCopilotAuthManager.getEmail()) ?? undefined,
		githubCopilotModels,
	}
}
