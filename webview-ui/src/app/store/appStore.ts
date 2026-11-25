import { Environment } from "@shared/config-types"
import type { ExtensionState } from "@shared/ExtensionMessage"
import type { PresentationBatch } from "@shared/PresentationOperation"
import type { ReleaseNotesView } from "@shared/release-notes"
import { EmptyRequest } from "@shared/proto/dirac/common"
import { create } from "zustand"
import { useTaskStore } from "@/entities/task/store/taskStore"
import { useChatStore } from "@/features/chat/store/chatStore"
import { useSettingsStore } from "@/features/settings/store/settingsStore"
import { StateServiceClient, UiServiceClient } from "@/shared/api/grpc-client"

interface AppState {
	version: string
	shouldShowAnnouncement: boolean
	releaseNotes?: ReleaseNotesView
	setShouldShowAnnouncement: (show: boolean) => void
	onboardingModels?: any
	environment: Environment
	onRelinquishControl: (callback: () => void) => () => void
	showSettings: boolean
	settingsTargetSection?: string
	showHistory: boolean
	showAccount: boolean
	showWorktrees: boolean
	showAnnouncement: boolean
	showWelcome: boolean
	expandTaskHeader: boolean
	didHydrateState: boolean

	// Actions
	setShowSettings: (show: boolean) => void
	setSettingsTargetSection: (section?: string) => void
	setShowHistory: (show: boolean) => void
	setShowAccount: (show: boolean) => void
	setShowWorktrees: (show: boolean) => void
	setShowAnnouncement: (show: boolean) => void
	setShowWelcome: (show: boolean) => void
	setExpandTaskHeader: (expand: boolean) => void
	setDidHydrateState: (hydrated: boolean) => void

	// Navigation
	navigateToSettings: (targetSection?: string) => void
	navigateToSettingsModelPicker: (opts: { targetSection?: string }) => void
	navigateToHistory: () => void
	navigateToAccount: () => void
	navigateToWorktrees: () => void
	navigateToChat: () => void

	// Hide
	hideSettings: () => void
	hideHistory: () => void
	hideAccount: () => void
	hideWorktrees: () => void
	hideAnnouncement: () => void

	// Hydration
	hydrate: () => () => void
}

export const useAppStore = create<AppState>((set) => ({
	environment: Environment.production,
	onRelinquishControl: () => () => {},
	showSettings: false,
	settingsTargetSection: undefined,
	showHistory: false,
	showAccount: false,
	version: "0.0.0",
	shouldShowAnnouncement: false,
	releaseNotes: undefined,
	onboardingModels: undefined,
	showWorktrees: false,
	showAnnouncement: false,
	showWelcome: false,
	expandTaskHeader: false,
	didHydrateState: false,

	setShowSettings: (show) => set({ showSettings: show }),
	setSettingsTargetSection: (section) => set({ settingsTargetSection: section }),
	setShowHistory: (show) => set({ showHistory: show }),
	setShowAccount: (show) => set({ showAccount: show }),
	setShowWorktrees: (show) => set({ showWorktrees: show }),
	setShowAnnouncement: (show) => set({ showAnnouncement: show }),
	setShowWelcome: (show) => set({ showWelcome: show }),
	setExpandTaskHeader: (expand) => set({ expandTaskHeader: expand }),
	setDidHydrateState: (hydrated) => set({ didHydrateState: hydrated }),
	setShouldShowAnnouncement: (show) => set({ shouldShowAnnouncement: show }),

	navigateToSettings: (targetSection) =>
		set({
			showHistory: false,
			showAccount: false,
			showWorktrees: false,
			settingsTargetSection: targetSection,
			showSettings: true,
		}),
	navigateToSettingsModelPicker: (opts) =>
		set({
			showHistory: false,
			showAccount: false,
			showWorktrees: false,
			settingsTargetSection: opts.targetSection,
			showSettings: true,
		}),
	navigateToHistory: () =>
		set({
			showSettings: false,
			showAccount: false,
			showWorktrees: false,
			showHistory: true,
		}),
	navigateToAccount: () =>
		set({
			showSettings: false,
			showHistory: false,
			showWorktrees: false,
			showAccount: true,
		}),
	navigateToWorktrees: () =>
		set({
			showSettings: false,
			showHistory: false,
			showAccount: false,
			showWorktrees: true,
		}),
	navigateToChat: () =>
		set({
			showSettings: false,
			showHistory: false,
			showAccount: false,
			showWorktrees: false,
		}),

	hideSettings: () =>
		set({
			showSettings: false,
			settingsTargetSection: undefined,
		}),
	hideHistory: () => set({ showHistory: false }),
	hideAccount: () => set({ showAccount: false }),
	hideWorktrees: () => set({ showWorktrees: false }),
	hideAnnouncement: () => set({ showAnnouncement: false }),

	hydrate: () => {
		const { setDidHydrateState } = useAppStore.getState()
		const applyState = (parsedState: Partial<ExtensionState>) => {
			useChatStore.getState().applyExtensionState(parsedState)
			set({
				...(parsedState.version !== undefined ? { version: parsedState.version } : {}),
				...(parsedState.shouldShowAnnouncement !== undefined
					? { shouldShowAnnouncement: parsedState.shouldShowAnnouncement }
					: {}),
				...(parsedState.releaseNotes !== undefined ? { releaseNotes: parsedState.releaseNotes } : {}),
				...(parsedState.onboardingModels !== undefined ? { onboardingModels: parsedState.onboardingModels } : {}),
				...(parsedState.welcomeViewCompleted !== undefined ? { showWelcome: !parsedState.welcomeViewCompleted } : {}),
			})
			useSettingsStore.getState().setSettings(parsedState as any)
			if (parsedState.taskHistory) useTaskStore.getState().setTaskHistory(parsedState.taskHistory)
			if ("currentTaskItem" in parsedState) useTaskStore.getState().setCurrentTaskItem(parsedState.currentTaskItem)
		}
		const recoverPresentation = async () => {
			const latest = await StateServiceClient.getLatestState({} as EmptyRequest)
			if (!latest.stateJson) throw new Error("Presentation recovery returned no state")
			applyState(JSON.parse(latest.stateJson) as ExtensionState)
		}

		// 1. Initialize webview
		UiServiceClient.initializeWebview({} as EmptyRequest).catch((error) => {
			console.error("Failed to initialize webview:", error)
		})

		// 2. Subscribe to state updates
		const cleanupState = StateServiceClient.subscribeToState({} as EmptyRequest, {
			onResponse: (state) => {
				if (!state.stateJson) return
				applyState(JSON.parse(state.stateJson) as Partial<ExtensionState>)
				if (state.presentationJson) {
					const result = useChatStore
						.getState()
						.applyPresentationBatch(JSON.parse(state.presentationJson) as PresentationBatch)
					if (result === "gap") {
						void recoverPresentation().catch((error) => console.error("Failed to recover presentation state:", error))
					}
				}

				setDidHydrateState(true)
			},
			onError: (error) => {
				console.error("Error in state subscription:", error)
			},
			onComplete: () => {},
		})

		// 3. Subscribe to navigation events
		const cleanupHistory = UiServiceClient.subscribeToHistoryButtonClicked({} as EmptyRequest, {
			onResponse: () => useAppStore.getState().navigateToHistory(),
			onError: (error) => console.error("Error in history button subscription:", error),
			onComplete: () => {},
		})

		const cleanupSettings = UiServiceClient.subscribeToSettingsButtonClicked({} as EmptyRequest, {
			onResponse: () => useAppStore.getState().navigateToSettings(),
			onError: (error) => console.error("Error in settings button subscription:", error),
			onComplete: () => {},
		})

		const cleanupChat = UiServiceClient.subscribeToChatButtonClicked({} as EmptyRequest, {
			onResponse: () => useAppStore.getState().navigateToChat(),
			onError: (error) => console.error("Error in chat button subscription:", error),
			onComplete: () => {},
		})

		const cleanupAccount = UiServiceClient.subscribeToAccountButtonClicked({} as EmptyRequest, {
			onResponse: () => useAppStore.getState().navigateToAccount(),
			onError: (error) => console.error("Error in account button subscription:", error),
			onComplete: () => {},
		})

		return () => {
			cleanupState()
			cleanupHistory()
			cleanupSettings()
			cleanupChat()
			cleanupAccount()
		}
	},
}))
