/**
 * Narrow target for shared URI callbacks (OAuth redirects, task creation).
 * `Controller` satisfies this structurally; core registers a resolver so
 * services/integrations never import `DiracWebviewProvider` or `Controller`.
 */
export interface UriCallbackTarget {
	completeOpenRouterAuth(code: string): Promise<void>
	completeRequestyAuth(code: string): Promise<void>
	createTask(prompt: string): Promise<void>
}

// Registered by core at DiracWebviewProvider module load; resolves the controller
// behind the currently visible webview.
let provider: (() => UriCallbackTarget | undefined) | undefined

export function initializeUriCallbackTarget(targetProvider: () => UriCallbackTarget | undefined): void {
	provider = targetProvider
}

export function getUriCallbackTarget(): UriCallbackTarget | undefined {
	return provider?.()
}

/** Test seam — clears the registered provider. */
export function resetUriCallbackTarget(): void {
	provider = undefined
}
