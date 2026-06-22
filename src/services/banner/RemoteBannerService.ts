import type { Banner, BannerRules, BannersResponse } from "@shared/DiracBanner"
import { fetch, isRateLimited, jsonHeaders } from "@shared/net"
import { DiracEnv } from "@/config"
import { Controller } from "@/core/controller"
import { StateManager } from "@/core/storage/StateManager"
import { HostInfo } from "@/registry"
import { FeatureFlag } from "@/shared/services/feature-flags/feature-flags"
import { Logger } from "@/shared/services/Logger"
import { buildBasicDiracHeaders } from "../EnvUtils"
import { featureFlagsService } from "../feature-flags"

const DEFAULT_CACHE_DURATION_MS = 24 * 60 * 60 * 1000
const CIRCUIT_BREAKER_TIMEOUT_MS = 60 * 60 * 1000 // 1 hour
const SERVER_ERROR_BACKOFF_MS = 15 * 60 * 1000 // 15 minutes
const AUTH_DEBOUNCE_MS = 1000 // 1 second
const FETCH_TIMEOUT_MS = 10000 // 10 seconds
const MAX_CONSECUTIVE_FAILURES = 3

const OS_MAP: Record<string, string> = { win32: "windows", linux: "linux", darwin: "macos" }
const IDE_MAP: Record<string, string> = { vscode: "vscode", jetbrains: "jetbrains", cli: "cli" }
const PROVIDER_ALIASES: Record<string, string[]> = {
	anthropic: ["anthropic", "claude-code"],
	openai: ["openai", "openai-native"],
	qwen: ["qwen", "qwen-code"],
}

/** Remote banner fetch, caching, backoff, and event reporting. */
export class RemoteBannerService {
	cachedBanners: Banner[] = []
	lastFetchTime = 0
	backoffUntil = 0
	consecutiveFailures = 0
	userId: string | null = null
	fetchPromise: Promise<Banner[]> | null = null
	abortController: AbortController | null = null
	debounceTimer: ReturnType<typeof setTimeout> | null = null
	pendingDebounceResolve: (() => void) | null = null
	authFetchPending = false

	constructor(
		private readonly controller: Controller,
		private readonly hostInfo: HostInfo,
	) {
		Logger.log("[RemoteBannerService] initialized")
	}

	getCachedBanners(): Banner[] {
		return this.cachedBanners
	}

	ensureFreshCache(): void {
		const now = Date.now()
		const cacheDurationMs = this.getCacheDurationMs()
		const shouldFetch =
			now >= this.backoffUntil &&
			now - this.lastFetchTime >= cacheDurationMs &&
			!this.fetchPromise &&
			!this.authFetchPending

		if (shouldFetch) {
			this.fetchPromise = this.fetchBanners()
			this.fetchPromise.finally(() => {
				this.fetchPromise = null
			})
		}
	}

	getCacheDurationMs(): number {
		const flagPayload = featureFlagsService.getFlagPayload(FeatureFlag.EXTENSION_REMOTE_BANNERS_TTL)
		const ms = typeof flagPayload === "number" && Number.isFinite(flagPayload) ? flagPayload : DEFAULT_CACHE_DURATION_MS
		if (!Number.isFinite(ms) || ms <= 0) return DEFAULT_CACHE_DURATION_MS
		return ms
	}

	clearCache(): void {
		this.abortController?.abort()
		this.abortController = null
		this.cachedBanners = []
		this.lastFetchTime = 0
		this.consecutiveFailures = 0
		this.backoffUntil = 0
		this.fetchPromise = null
	}

	async onAuthUpdate(userId: string | null): Promise<void> {
		if (this.userId === userId) return

		// Clear existing debounce timer and resolve any pending promise
		if (this.debounceTimer) {
			clearTimeout(this.debounceTimer)
			this.debounceTimer = null
		}
		if (this.pendingDebounceResolve) {
			this.pendingDebounceResolve()
			this.pendingDebounceResolve = null
		}

		// Cancel any in-progress fetch immediately - we'll fetch with the new token after debounce
		this.abortController?.abort()
		this.abortController = null
		this.fetchPromise = null

		// Set pending flag immediately to prevent getActiveBanners() from starting a fetch
		// while we're waiting for the debounce to settle
		this.authFetchPending = true
		this.userId = userId

		return new Promise<void>((resolve) => {
			this.pendingDebounceResolve = resolve
			this.debounceTimer = setTimeout(async () => {
				this.debounceTimer = null
				this.pendingDebounceResolve = null

				this.consecutiveFailures = 0
				this.backoffUntil = 0

				try {
					await this.fetchBanners()
				} finally {
					this.authFetchPending = false
					resolve()
				}
			}, AUTH_DEBOUNCE_MS)
		})
	}

	async sendBannerEvent(bannerId: string, eventType: "dismiss"): Promise<void> {
		try {
			const url = new URL("/banners/v2/messages", DiracEnv.config().apiBaseUrl).toString()
			const ideType = this.getIdeType()
			const surface = ideType === "cli" ? "cli" : ideType === "jetbrains" ? "jetbrains" : "vscode"

			const controller = new AbortController()
			const timeoutId = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)

			try {
				await fetch(url, {
					method: "POST",
					headers: { ...jsonHeaders(), ...(await buildBasicDiracHeaders()) },
					body: JSON.stringify({
						banner_id: bannerId,
						instance_id: this.hostInfo.distinctId,
						surface,
						event_type: eventType,
					}),
					signal: controller.signal,
				})
			} finally {
				clearTimeout(timeoutId)
			}
		} catch (error) {
			Logger.error("[RemoteBannerService] Error sending banner event", error)
		}
	}

	async fetchBanners(): Promise<Banner[]> {
		// Do not fetch banners when feature flag is off
		if (!featureFlagsService.getBooleanFlagEnabled(FeatureFlag.REMOTE_BANNERS)) return []

		this.abortController = new AbortController()
		const { signal } = this.abortController
		const timeoutId = setTimeout(() => this.abortController?.abort(), FETCH_TIMEOUT_MS)

		try {
			const url = this.buildFetchUrl()
			const headers: Record<string, string> = { ...jsonHeaders(), ...(await buildBasicDiracHeaders()) }
			const authToken = undefined
			if (authToken) headers.Authorization = `Bearer ${authToken}`

			const response = await fetch(url, { method: "GET", headers, signal })
			clearTimeout(timeoutId)

			if (!response.ok) {
				throw Object.assign(new Error(`HTTP ${response.status}`), {
					status: response.status,
					headers: response.headers,
				})
			}

			const data = (await response.json()) as BannersResponse
			if (!data?.data?.items || !Array.isArray(data.data.items)) return []

			const banners = data.data.items.filter((b) => this.matchesProviderRule(b))
			this.cachedBanners = banners
			this.lastFetchTime = Date.now()
			this.consecutiveFailures = 0

			Logger.log(
				`[RemoteBannerService] After provider filter: ${banners.length} banners: ${JSON.stringify(
					banners.map((b) => ({ id: b.id, placement: b.placement })),
				)}`,
			)

			this.controller.postStateToWebview().catch((error) => {
				Logger.error("Failed to post state to webview after fetching banners:", error)
			})
			return banners
		} catch (error) {
			clearTimeout(timeoutId)

			if (error instanceof Error && error.name === "AbortError") return this.cachedBanners

			this.handleFetchError(error)
			return this.cachedBanners
		} finally {
			this.abortController = null
		}
	}

	private handleFetchError(error: unknown): void {
		this.consecutiveFailures++

		const typedError = error as { status?: number; headers?: { get(name: string): string | null } }
		const status = typedError.status

		let backoffMs = CIRCUIT_BREAKER_TIMEOUT_MS

		if (status && isRateLimited(status)) {
			const retryAfter = typedError.headers?.get("retry-after")
			if (retryAfter) {
				const seconds = Number.parseInt(retryAfter, 10)
				if (!Number.isNaN(seconds)) {
					backoffMs = seconds * 1000
				} else {
					const date = new Date(retryAfter)
					if (!Number.isNaN(date.getTime())) backoffMs = Math.max(0, date.getTime() - Date.now())
				}
			}
		} else if (status && status >= 500 && status < 600) {
			backoffMs = SERVER_ERROR_BACKOFF_MS
		}

		this.backoffUntil = Date.now() + backoffMs

		if (this.consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
			this.backoffUntil = Date.now() + CIRCUIT_BREAKER_TIMEOUT_MS
			const msg =
				this.consecutiveFailures === MAX_CONSECUTIVE_FAILURES ? "Circuit breaker tripped" : "Half-open recovery failed"
			Logger.log(`RemoteBannerService: ${msg}, will allow recovery attempt after 1 hour`)
		}

		Logger.error(
			`[RemoteBannerService] Failed ${this.consecutiveFailures}/${MAX_CONSECUTIVE_FAILURES}. ` +
				`Backing off for ${Math.ceil(backoffMs / 60000)} minutes`,
			error,
		)
	}

	private buildFetchUrl(): string {
		const url = new URL("/banners/v2/messages", DiracEnv.config().apiBaseUrl)
		url.searchParams.set("ide", this.getIdeType())
		url.searchParams.set("extension_version", this.hostInfo.extensionVersion)
		url.searchParams.set("os", OS_MAP[this.hostInfo.os] || "unknown")
		return url.toString()
	}

	private getIdeType(): string {
		const ide = this.hostInfo.ide?.toLowerCase() ?? ""
		for (const [key, value] of Object.entries(IDE_MAP)) {
			if (ide.includes(key)) return value
		}

		const platform = this.hostInfo.platform?.toLowerCase() ?? ""
		if (platform.includes("visual studio") || platform.includes("vscode")) return "vscode"
		return "unknown"
	}

	private matchesProviderRule(banner: Banner): boolean {
		try {
			const rules: BannerRules = JSON.parse(banner.rulesJson || "{}")
			if (!rules?.providers?.length) return true

			const config = StateManager.get().getApiConfiguration()
			const mode = StateManager.get().getGlobalSettingsKey("mode")
			const provider = mode === "plan" ? config?.planModeApiProvider : config?.actModeApiProvider

			return rules.providers.some((ruleProvider) => {
				// Check if ruleProvider is an alias for the selected provider
				for (const [, aliases] of Object.entries(PROVIDER_ALIASES)) {
					if (aliases.includes(ruleProvider)) return aliases.includes(provider as string)
				}
				return provider === ruleProvider
			})
		} catch (error) {
			Logger.log(
				`[RemoteBannerService] Error parsing provider rules for banner ${banner.id}: ` +
					`${error instanceof Error ? error.message : String(error)}`,
			)
			return true // Fail open
		}
	}
}
