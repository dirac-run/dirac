import type * as acp from "@agentclientprotocol/sdk"
import type { ApiProvider } from "@shared/api"
import { StateManager } from "@/core/storage/StateManager"

const OPENAI_DEFAULT_BASE_URL = "https://api.openai.com/v1"
const ANTHROPIC_DEFAULT_BASE_URL = "https://api.anthropic.com"

const PROVIDERS: Record<
	string,
	{
		supported: acp.LlmProtocol[]
		defaultBaseUrl: string
	}
> = {
	openai: { supported: ["openai", "azure"], defaultBaseUrl: OPENAI_DEFAULT_BASE_URL },
	anthropic: { supported: ["anthropic"], defaultBaseUrl: ANTHROPIC_DEFAULT_BASE_URL },
}

function normalizedBaseUrl(baseUrl: string): string {
	const url = new URL(baseUrl)
	if (url.protocol !== "http:" && url.protocol !== "https:") {
		throw new Error(`Provider base URL must use HTTP or HTTPS: ${baseUrl}`)
	}
	return baseUrl.replace(/\/+$/, "")
}

function headerValue(headers: Record<string, string>, name: string): string | undefined {
	const entry = Object.entries(headers).find(([key]) => key.toLowerCase() === name.toLowerCase())
	return entry?.[1]
}

function bearerToken(headers: Record<string, string>): string | undefined {
	const authorization = headerValue(headers, "authorization")
	if (!authorization) return undefined
	const match = authorization.match(/^Bearer\s+(.+)$/i)
	if (!match) throw new Error("Authorization header must use the Bearer scheme")
	return match[1]
}

function headersWithoutAuthentication(headers: Record<string, string>): Record<string, string> {
	return Object.fromEntries(
		Object.entries(headers).filter(([key]) => {
			const normalized = key.toLowerCase()
			return normalized !== "authorization" && normalized !== "api-key" && normalized !== "x-api-key"
		}),
	)
}

/**
 * Stable Dirac provider-provisioning boundary.
 *
 * ACP currently exposes this through unstable method names. Keeping those names out
 * of this service means a future stable ACP rename only changes the transport adapters.
 */
export class ProviderConfigurationManager {
	listProviders(): acp.ListProvidersResponse {
		const stateManager = StateManager.get()
		const configuration = stateManager.getApiConfiguration()
		const disabled = this.disabledProviderIds()

		return {
			providers: Object.entries(PROVIDERS).map(([providerId, definition]) => ({
				providerId,
				supported: definition.supported,
				required: false,
				...(disabled.has(providerId)
					? {}
					: {
							current: {
								apiType: this.currentApiType(providerId, configuration),
								baseUrl: this.currentBaseUrl(providerId, configuration, definition.defaultBaseUrl),
							},
						}),
			})),
		}
	}

	async setProvider(params: acp.SetProviderRequest): Promise<void> {
		const definition = PROVIDERS[params.providerId]
		if (!definition) throw new Error(`Provider is not configurable through ACP: ${params.providerId}`)
		if (!definition.supported.includes(params.apiType)) {
			throw new Error(`Provider ${params.providerId} does not support ACP protocol ${params.apiType}`)
		}

		const baseUrl = normalizedBaseUrl(params.baseUrl)
		const headers = params.headers ?? {}
		const stateManager = StateManager.get()

		if (params.providerId === "openai") {
			const apiKey = bearerToken(headers) ?? headerValue(headers, "api-key")
			stateManager.setApiConfiguration({
				openAiBaseUrl: baseUrl,
				openAiHeaders: headersWithoutAuthentication(headers),
				openAiApiKey: apiKey,
				openAiCompatibleCustomApiKey: undefined,
				azureApiVersion:
					params.apiType === "azure"
						? (headerValue(headers, "api-version") ?? stateManager.getGlobalSettingsKey("azureApiVersion"))
						: undefined,
			})
		} else {
			const apiKey = headerValue(headers, "x-api-key") ?? bearerToken(headers)
			stateManager.setApiConfiguration({
				anthropicBaseUrl: baseUrl,
				anthropicHeaders: headersWithoutAuthentication(headers),
				apiKey,
			})
		}

		this.setApiType(params.providerId, params.apiType)
		this.setDisabled(params.providerId, false)
		await stateManager.flushPendingState()
	}

	async disableProvider(params: acp.DisableProviderRequest): Promise<void> {
		if (!PROVIDERS[params.providerId]) {
			throw new Error(`Provider is not configurable through ACP: ${params.providerId}`)
		}

		const stateManager = StateManager.get()
		if (params.providerId === "openai") {
			stateManager.setApiConfiguration({
				openAiBaseUrl: undefined,
				openAiHeaders: {},
				openAiApiKey: undefined,
				openAiCompatibleCustomApiKey: undefined,
			})
		} else {
			stateManager.setApiConfiguration({
				anthropicBaseUrl: undefined,
				anthropicHeaders: {},
				apiKey: undefined,
			})
		}
		this.setDisabled(params.providerId, true)
		await stateManager.flushPendingState()
	}

	isProviderEnabled(providerId: string): boolean {
		return !PROVIDERS[providerId] || !this.disabledProviderIds().has(providerId)
	}

	assertProviderEnabled(providerId: ApiProvider): void {
		if (!this.isProviderEnabled(providerId)) {
			throw new Error(`Provider ${providerId} is disabled through ACP provider configuration`)
		}
	}

	private currentApiType(providerId: string, configuration: ReturnType<StateManager["getApiConfiguration"]>): acp.LlmProtocol {
		const configured = StateManager.get().getGlobalSettingsKey("acpProviderApiTypes")?.[providerId]
		if (configured) return configured
		if (providerId === "anthropic") return "anthropic"
		const baseUrl = configuration.openAiBaseUrl?.toLowerCase() ?? ""
		return baseUrl.includes("azure.com") || baseUrl.includes("azure.us") ? "azure" : "openai"
	}

	private currentBaseUrl(
		providerId: string,
		configuration: ReturnType<StateManager["getApiConfiguration"]>,
		defaultBaseUrl: string,
	): string {
		return providerId === "openai"
			? configuration.openAiBaseUrl || defaultBaseUrl
			: configuration.anthropicBaseUrl || defaultBaseUrl
	}

	private disabledProviderIds(): Set<string> {
		return new Set(Object.keys(StateManager.get().getGlobalSettingsKey("acpDisabledProviders") ?? {}))
	}

	private setDisabled(providerId: string, disabled: boolean): void {
		const disabledProviders = { ...(StateManager.get().getGlobalSettingsKey("acpDisabledProviders") ?? {}) }
		if (disabled) disabledProviders[providerId] = "disabled"
		else delete disabledProviders[providerId]
		StateManager.get().setGlobalState("acpDisabledProviders", disabledProviders)
	}

	private setApiType(providerId: string, apiType: acp.LlmProtocol): void {
		const apiTypes = { ...(StateManager.get().getGlobalSettingsKey("acpProviderApiTypes") ?? {}) }
		apiTypes[providerId] = apiType
		StateManager.get().setGlobalState("acpProviderApiTypes", apiTypes)
	}
}
