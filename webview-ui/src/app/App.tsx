import type { Boolean, EmptyRequest } from "@shared/proto/dirac/common"
import { useCallback, useEffect, useState } from "react"
import { useAppStore } from "@/app/store/appStore"
import ChatView from "@/features/chat/components/ChatView/ChatView"
import { useBannerAction } from "@/features/banners/hooks/useBannerAction"
import HistoryView from "@/features/history/components/HistoryView/HistoryView"
import SettingsView from "@/features/settings/components/SettingsView/SettingsView"
import { useSettingsStore } from "@/features/settings/store/settingsStore"
import WorktreesView from "@/features/worktrees/components/WorktreesView"
import { StateServiceClient, UiServiceClient } from "@/shared/api/grpc-client"
import ReleaseNotesModal from "@/shared/ui/ReleaseNotesModal"
import { Providers } from "./Providers"

const AppContent = () => {
	const {
		didHydrateState,
		shouldShowAnnouncement,
		releaseNotes,
		showSettings,
		settingsTargetSection,
		showHistory,
		showWorktrees,
		showAnnouncement,
		setShowAnnouncement,
		setShouldShowAnnouncement,
		navigateToHistory,
		hideSettings,
		hideHistory,
		hideWorktrees,
		hideAnnouncement,
	} = useAppStore()
	const hydrate = useAppStore((state) => state.hydrate)
	const remoteNotes = useSettingsStore((state) => state.welcomeBanners)
	const handleBannerAction = useBannerAction()
	const [showReleaseNotes, setShowReleaseNotes] = useState(false)

	useEffect(() => {
		const cleanup = hydrate()
		return cleanup
	}, [hydrate])

	useEffect(() => {
		if (!shouldShowAnnouncement) return
		if (releaseNotes) {
			setShowReleaseNotes(true)
			return
		}

		setShowAnnouncement(true)
		UiServiceClient.onDidShowAnnouncement({} as EmptyRequest)
			.then((response: Boolean) => {
				setShouldShowAnnouncement(response.value)
			})
			.catch((error: any) => {
				console.error("Failed to acknowledge announcement:", error)
			})
	}, [releaseNotes, shouldShowAnnouncement, setShouldShowAnnouncement, setShowAnnouncement])

	const closeReleaseNotes = useCallback(() => {
		setShowReleaseNotes(false)
		for (const note of remoteNotes ?? []) {
			StateServiceClient.dismissBanner({ value: note.id }).catch(console.error)
		}
		UiServiceClient.onDidShowAnnouncement({} as EmptyRequest)
			.then((response: Boolean) => {
				setShouldShowAnnouncement(response.value)
			})
			.catch((error: any) => {
				console.error("Failed to acknowledge release notes:", error)
			})
	}, [remoteNotes, setShouldShowAnnouncement])

	if (!didHydrateState) {
		return null
	}

	return (
		<div className="flex h-screen w-full flex-col">
			{releaseNotes && (
				<ReleaseNotesModal
					onClose={closeReleaseNotes}
					onRemoteAction={handleBannerAction}
					open={showReleaseNotes}
					releaseNotes={releaseNotes}
					remoteNotes={remoteNotes}
				/>
			)}
			{showSettings && <SettingsView onDone={hideSettings} targetSection={settingsTargetSection} />}
			{showHistory && <HistoryView onDone={hideHistory} />}
			{showWorktrees && <WorktreesView onDone={hideWorktrees} />}
			{/* Do not conditionally load ChatView, it's expensive and there's state we don't want to lose (user input, disableInput, askResponse promise, etc.) */}
			<ChatView
				hideAnnouncement={hideAnnouncement}
				isHidden={showSettings || showHistory || showWorktrees}
				showAnnouncement={showAnnouncement}
				showHistoryView={navigateToHistory}
			/>
		</div>
	)
}

const App = () => {
	return (
		<Providers>
			<AppContent />
		</Providers>
	)
}

export default App
