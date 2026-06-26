import { exit } from "node:process"
import type { ApiProvider } from "@shared/api"
import type { CliContext } from "../types"
import { initializeCli } from "../init"
import { disposeCliContext } from "../utils/cleanup"
import { runInkApp } from "../utils/ink"

/**
 * Determines if the auth command should proceed with quick setup (non-interactive)
 * based on provided flags and inferred values (from environment).
 */
export function shouldDoQuickAuth(
	options: {
		provider?: string
		apikey?: string
		modelid?: string
		baseurl?: string
		azureApiVersion?: string
	},
	inferred: {
		provider?: string
		apikey?: string
		modelid?: string
	},
): boolean {
	const hasAnyAuthFlag = !!(options.provider || options.apikey || options.modelid || options.baseurl || options.azureApiVersion)
	const hasAllRequiredFields = !!(inferred.provider && inferred.apikey && inferred.modelid)

	// We do quick setup if we have all required fields AND the user provided at least one flag.
	return hasAllRequiredFields && hasAnyAuthFlag
}

export function hasExplicitAuthQuickSetupFlags(options: { provider?: string; apikey?: string; modelid?: string }): boolean {
	return !!(options.provider && options.apikey && options.modelid)
}

/**
 * Perform quick auth setup without UI - validates and saves configuration directly
 */
export async function performQuickAuthSetup(
	ctx: CliContext,
	options: { provider: string; apikey: string; modelid: string; baseurl?: string; azureApiVersion?: string },
): Promise<{ success: boolean; error?: string }> {
	const { isValidCliProvider, getValidCliProviders } = await import("../utils/providers")
	const { applyProviderConfig } = await import("../utils/provider-config")
	const { ProviderToBaseUrlKeyMap } = await import("@shared/storage")
	const { StateManager } = await import("@/core/storage/StateManager")

	const { provider, apikey, modelid, baseurl, azureApiVersion } = options

	const normalizedProvider = provider.toLowerCase().trim()

	if (!isValidCliProvider(normalizedProvider)) {
		const validProviders = getValidCliProviders()
		return {
			success: false,
			error: `Invalid provider '${provider}'. Supported providers: ${validProviders.join(", ")}`,
		}
	}

	if (normalizedProvider === "bedrock") {
		return {
			success: false,
			error: "Bedrock provider is not supported for quick setup due to complex authentication requirements. Please use interactive setup.",
		}
	}

	if (baseurl && !ProviderToBaseUrlKeyMap[normalizedProvider as ApiProvider]) {
		return { success: false, error: "Base URL is not supported for this provider" }
	}

	// Save configuration using shared utility
	await applyProviderConfig({
		providerId: normalizedProvider,
		apiKey: apikey,
		modelId: modelid,
		baseUrl: baseurl,
		azureApiVersion: azureApiVersion,
		controller: ctx.controller,
	})

	// Mark onboarding as complete
	StateManager.get().setGlobalState("welcomeViewCompleted", true)
	await StateManager.get().flushPendingState()

	return { success: true }
}

/**
 * Run authentication flow
 */
export async function runAuth(options: {
	provider?: string
	apikey?: string
	modelid?: string
	baseurl?: string
	azureApiVersion?: string
	verbose?: boolean
	cwd?: string
	config?: string
}) {
	const { telemetryService } = await import("@/services/telemetry")
	const { printWarning, printInfo } = await import("../utils/display")
	const { checkRawModeSupport } = await import("../context/StdinContext")
	const React = (await import("react")).default
	const { App } = await import("../components/App")

	const ctx = await initializeCli({ ...options, enableAuth: true })

	let provider = options.provider
	let apikey = options.apikey
	let modelid = options.modelid

	if (!provider || !apikey || !modelid) {
		const { getSecretsFromEnv, getProviderFromEnv } = await import("@shared/storage/env-config")
		const { ProviderToApiKeyMap, getProviderDefaultModelId } = await import("@shared/storage")

		if (!provider) {
			provider = getProviderFromEnv()
			if (provider) {
				printInfo(`Inferred provider "${provider}" from environment variables`)
			}
		}

		if (provider && !apikey) {
			const envSecrets = getSecretsFromEnv()
			const normalizedProvider = provider.toLowerCase().trim()
			const secretKeyOrKeys = (ProviderToApiKeyMap as any)[normalizedProvider]
			if (secretKeyOrKeys) {
				const keys = Array.isArray(secretKeyOrKeys) ? secretKeyOrKeys : [secretKeyOrKeys]
				for (const key of keys) {
					const value = envSecrets[key as keyof typeof envSecrets]
					if (value) {
						apikey = value
						printInfo(`Using API key from environment for provider "${provider}"`)
						break
					}
				}
			}
		}

		if (provider && !modelid) {
			modelid = (getProviderDefaultModelId as any)(provider) || undefined
			if (modelid) {
				printInfo(`Using default model "${modelid}" for provider "${provider}"`)
			}
		}
	}
	const isQuickSetup = shouldDoQuickAuth(options, { provider, apikey, modelid })

	telemetryService.captureHostEvent("auth_command", isQuickSetup ? "quick_setup" : "interactive")

	// Quick setup mode - no UI, just save configuration and exit
	if (isQuickSetup) {
		const result = await performQuickAuthSetup(ctx, {
			provider: provider!,
			apikey: apikey!,
			modelid: modelid!,
			baseurl: options.baseurl,
			azureApiVersion: options.azureApiVersion,
		})

		if (!result.success) {
			printWarning(result.error || "Quick setup failed")
			await telemetryService.captureHostEvent("auth", "error")
			await disposeCliContext(ctx)
			exit(1)
		}

		await telemetryService.captureHostEvent("auth", "completed")
		await disposeCliContext(ctx)
		exit(0)
	}

	// Interactive mode - show Ink UI
	let authError = false

	await runInkApp(
		React.createElement(App, {
			view: "auth",
			controller: ctx.controller,
			isRawModeSupported: checkRawModeSupport(),
			onComplete: () => {
				telemetryService.captureHostEvent("auth", "completed")
			},
			onError: () => {
				telemetryService.captureHostEvent("auth", "error")
				authError = true
			},
		}),
		async () => {
			await disposeCliContext(ctx)
			exit(authError ? 1 : 0)
		},
	)
}
