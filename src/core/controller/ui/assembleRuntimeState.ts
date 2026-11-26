import type { ExtensionState } from "@shared/ExtensionMessage"
import { DiracEnv } from "@/config"
import { ExtensionRegistryInfo } from "@/registry"
import { BannerService } from "@/services/banner/BannerService"
import { getDistinctId } from "@/services/logging/distinctId"
import { getPendingReleaseNotes } from "@/services/release-notes/ReleaseNotesService"
import type { StateManager } from "@core/storage/StateManager"

/** Collects host runtime vitals: platform, identity, version, environment, and banners. */
export async function assembleRuntimeState(stateManager: StateManager) {
	const latestAnnouncementId = (await import("@/utils/announcements")).getLatestAnnouncementId()
	return {
		platform: process.platform as ExtensionState["platform"],
		distinctId: getDistinctId(),
		version: ExtensionRegistryInfo.version,
		environment: DiracEnv.config().environment,
		banners: BannerService.get().getActiveBanners() ?? [],
		welcomeBanners: BannerService.get().getWelcomeBanners() ?? [],
		releaseNotes: getPendingReleaseNotes(stateManager),
		latestAnnouncementId,
	}
}
