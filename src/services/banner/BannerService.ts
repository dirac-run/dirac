import type { Banner, BannerAction } from "@shared/DiracBanner"
import { BannerActionType, type BannerCardData } from "@shared/dirac/banner"
import { Controller } from "@/core/controller"
import { StateManager } from "@/core/storage/StateManager"
import { HostInfo, HostRegistryInfo } from "@/registry"
import { Logger } from "@/shared/services/Logger"
import { RemoteBannerService } from "./RemoteBannerService"
import { WelcomeBannerService } from "./WelcomeBannerService"

/**
 * Facade for banner fetching, caching, and selection.
 * Delegates remote fetch/cache to RemoteBannerService and welcome logic to WelcomeBannerService.
 */
export class BannerService {
	private static instance: BannerService | null = null

	private readonly validActionTypes: Set<string>
	readonly remote: RemoteBannerService
	private readonly welcome: WelcomeBannerService

	private constructor(controller: Controller, hostInfo: HostInfo) {
		this.validActionTypes = new Set(Object.values(BannerActionType))
		this.remote = new RemoteBannerService(controller, hostInfo)
		this.welcome = new WelcomeBannerService(
			this.remote,
			(bannerId) => this.isBannerDismissed(bannerId),
			(banner) => this.toBannerCardData(banner),
		)
		Logger.log("[BannerService] initialized")
	}

	public static initialize(controller: Controller): BannerService {
		if (BannerService.instance) return BannerService.instance
		const hostInfo = HostRegistryInfo.get()
		if (!hostInfo) throw new Error("[BannerService] Ensure HostRegistryInfo is initialized before BannerService.")
		BannerService.instance = new BannerService(controller, hostInfo)
		return BannerService.instance
	}

	public static get(): BannerService {
		if (!BannerService.instance) {
			throw new Error("BannerService not initialized. Call BannerService.initialize(controller) first.")
		}
		return BannerService.instance
	}

	public static reset(): void {
		const instance = BannerService.instance
		if (instance) {
			if (instance.remote?.debounceTimer) clearTimeout(instance.remote.debounceTimer)
			instance.remote?.abortController?.abort()
		}
		BannerService.instance = null
	}

	public static async onAuthUpdate(userId: string | null): Promise<void> {
		const instance = BannerService.instance
		if (!instance) return
		return instance.remote.onAuthUpdate(userId)
	}

	public getActiveBanners(): BannerCardData[] {
		this.remote.ensureFreshCache()

		return this.remote
			.getCachedBanners()
			.filter((b) => b.placement !== "welcome")
			.filter((b) => !this.isBannerDismissed(b.id))
			.map((b) => this.toBannerCardData(b))
			.filter((b): b is BannerCardData => b !== null)
	}

	/** Returns welcome banners for the What's New modal, or undefined when the feature flag is off. */
	public getWelcomeBanners(): BannerCardData[] | undefined {
		return this.welcome.getWelcomeBanners()
	}

	public clearCache(): void {
		this.remote.clearCache()
	}

	public async dismissBanner(bannerId: string): Promise<void> {
		try {
			const dismissed = StateManager.get().getGlobalStateKey("dismissedBanners") || []
			if (dismissed.some((b) => b.bannerId === bannerId)) return

			StateManager.get().setGlobalState("dismissedBanners", [...dismissed, { bannerId, dismissedAt: Date.now() }])

			await this.remote.sendBannerEvent(bannerId, "dismiss")
			this.clearCache()
		} catch (error) {
			Logger.error("[BannerService] Error dismissing banner", error)
		}
	}

	public async sendBannerEvent(bannerId: string, eventType: "dismiss"): Promise<void> {
		return this.remote.sendBannerEvent(bannerId, eventType)
	}

	public isBannerDismissed(bannerId: string): boolean {
		try {
			const dismissed = StateManager.get().getGlobalStateKey("dismissedBanners") || []
			return dismissed.some((b) => b.bannerId === bannerId)
		} catch (error) {
			Logger.error("[BannerService] Error checking dismissed banner", error)
			return false
		}
	}

	private getBannerActions(banner: Banner): BannerAction[] {
		return banner.actions ?? []
	}

	private toBannerCardData(banner: Banner): BannerCardData | null {
		const actions = this.getBannerActions(banner)

		// Validate all actions have valid types
		for (const action of actions) {
			if (!action.action || !this.validActionTypes.has(action.action) || !action.title) {
				Logger.error(`[BannerService] Invalid action type (${action.action}) for banner ${banner.id}`)
				return null
			}
		}

		return {
			id: banner.id,
			title: banner.titleMd,
			description: banner.bodyMd,
			icon: banner.icon,
			actions: actions.map((a) => ({ title: a.title || "", action: a.action as BannerActionType, arg: a.arg })),
		}
	}
}
