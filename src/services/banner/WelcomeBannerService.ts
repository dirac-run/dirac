import { isDevelopmentMode } from "@shared/config/environment"
import type { Banner } from "@shared/DiracBanner"
import { type BannerCardData } from "@shared/dirac/banner"
import { FeatureFlag } from "@/shared/services/feature-flags/feature-flags"
import { featureFlagsService } from "../feature-flags"
import type { RemoteBannerService } from "./RemoteBannerService"

type IsDismissedFn = (bannerId: string) => boolean
type ToCardDataFn = (banner: Banner) => BannerCardData | null

/**
 * Welcome-banner selection logic for the What's New modal.
 * Version-targeted banners fetched from the backend, gated by REMOTE_WELCOME_BANNERS.
 */
export class WelcomeBannerService {
	constructor(
		private readonly remote: RemoteBannerService,
		private readonly isBannerDismissed: IsDismissedFn,
		private readonly toBannerCardData: ToCardDataFn,
	) {}

	/** Returns welcome banners, or undefined when the feature flag is off (webview falls back to hardcoded items). */
	getWelcomeBanners(): BannerCardData[] | undefined {
		const isLocal = isDevelopmentMode()
		const flagEnabled = isLocal || featureFlagsService.getBooleanFlagEnabled(FeatureFlag.REMOTE_WELCOME_BANNERS)
		if (!flagEnabled) return undefined

		const bypassDismissals = isDevelopmentMode()
		this.remote.ensureFreshCache()

		const welcomeCandidates = this.remote.getCachedBanners().filter((b) => b.placement === "welcome")

		return welcomeCandidates
			.filter((b) => bypassDismissals || !this.isBannerDismissed(b.id))
			.map((b) => this.toBannerCardData(b))
			.filter((b): b is BannerCardData => b !== null)
	}
}
