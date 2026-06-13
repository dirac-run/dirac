import { BANNER_DATA, BannerAction, BannerActionType, BannerCardData } from "@shared/dirac/banner"
import { EmptyRequest } from "@shared/proto/dirac/common"
import type { Worktree } from "@shared/proto/dirac/worktree"
import { TrackWorktreeViewOpenedRequest } from "@shared/proto/dirac/worktree"
import { GitBranch } from "lucide-react"
import React, { useCallback, useEffect, useMemo, useRef, useState, memo } from "react"
import { useDiracAuth } from "@/context/DiracAuthContext"
import HistoryPreview from "./HistoryPreview"
import { useApiConfigurationHandlers } from "@/features/settings/components/utils/useApiConfigurationHandlers"
import { useSettingsStore } from "@/features/settings/store/settingsStore"
import CreateWorktreeModal from "@/features/worktrees/components/CreateWorktreeModal"
import { StateServiceClient, UiServiceClient, WorktreeServiceClient } from "@/shared/api/grpc-client"
import { convertBannerData } from "@/shared/lib/bannerUtils"
import { getCurrentPlatform } from "@/shared/lib/platformUtils"
import BannerCarousel from "@/shared/ui/BannerCarousel"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/shared/ui/tooltip"
import WhatsNewModal from "@/shared/ui/WhatsNewModal"

interface ModularWelcomeSectionProps {
    showHistoryView: () => void
    version: string
    shouldShowQuickWins: boolean
    showAnnouncement: boolean
    hideAnnouncement: () => void
}

const ModularWelcomeSection: React.FC<ModularWelcomeSectionProps> = ({
    showHistoryView,
    version,
    shouldShowQuickWins,
    showAnnouncement,
    hideAnnouncement,
}) => {
    const { lastDismissedInfoBannerVersion, lastDismissedCliBannerVersion, lastDismissedModelBannerVersion, dismissedBanners } =
        useSettingsStore()

    // Track if we've shown the "What's New" modal this session
    const [hasShownWhatsNewModal, setHasShownWhatsNewModal] = useState(false)
    const [showWhatsNewModal, setShowWhatsNewModal] = useState(false)
    const bannerWaitTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)

    // Quick launch worktree modal
    const [showCreateWorktreeModal, setShowCreateWorktreeModal] = useState(false)
    const [isGitRepo, setIsGitRepo] = useState<boolean | null>(null)
    const [currentWorktree, setCurrentWorktree] = useState<Worktree | null>(null)

    // Check if we're in a git repo and get current worktree info on mount
    useEffect(() => {
        WorktreeServiceClient.listWorktrees(EmptyRequest.create({}))
            .then((result) => {
                const canUseWorktrees = result.isGitRepo && !result.isMultiRoot && !result.isSubfolder
                setIsGitRepo(canUseWorktrees)
                if (canUseWorktrees) {
                    const current = result.worktrees.find((w) => w.isCurrent)
                    setCurrentWorktree(current || null)
                }
            })
            .catch(() => setIsGitRepo(false))
    }, [])

    const { diracUser } = useDiracAuth()
    const {
        openRouterModels,
        navigateToSettings,
        navigateToSettingsModelPicker,
        navigateToWorktrees,
        worktreesEnabled,
        banners,
        welcomeBanners,
    } = useSettingsStore()
    const { handleFieldsChange } = useApiConfigurationHandlers()

    // Show modal when there's a new announcement and we haven't shown it this session.
    // We delay opening slightly to wait for welcome banners from the backend API,
    // which are fetched asynchronously and may not be available on the first state push.
    // The modal opens immediately if banners arrive, or after a 3s timeout as fallback.
    useEffect(() => {
        if (showAnnouncement && !hasShownWhatsNewModal && !bannerWaitTimeoutRef.current) {
            bannerWaitTimeoutRef.current = setTimeout(() => {
                bannerWaitTimeoutRef.current = null
                setShowWhatsNewModal(true)
                setHasShownWhatsNewModal(true)
            }, 3000)
        }
        return () => {
            if (bannerWaitTimeoutRef.current) {
                clearTimeout(bannerWaitTimeoutRef.current)
                bannerWaitTimeoutRef.current = null
            }
        }
    }, [showAnnouncement, hasShownWhatsNewModal])

    // Open modal early if welcome banners arrive before the timeout
    useEffect(() => {
        if (bannerWaitTimeoutRef.current && welcomeBanners && welcomeBanners.length > 0) {
            if (bannerWaitTimeoutRef.current) {
                clearTimeout(bannerWaitTimeoutRef.current)
                bannerWaitTimeoutRef.current = null
            }
            setShowWhatsNewModal(true)
            setHasShownWhatsNewModal(true)
        }
    }, [welcomeBanners])

    const handleCloseWhatsNewModal = useCallback(() => {
        setShowWhatsNewModal(false)
        // Call hideAnnouncement to persist dismissal (same as old banner behavior)
        hideAnnouncement()
        if (welcomeBanners && welcomeBanners.length > 0) {
            for (const banner of welcomeBanners) {
                StateServiceClient.dismissBanner({ value: banner.id }).catch(console.error)
            }
        }
    }, [hideAnnouncement, welcomeBanners])

    // Handle click on home page worktree element with telemetry
    const handleWorktreeClick = useCallback(() => {
        WorktreeServiceClient.trackWorktreeViewOpened(TrackWorktreeViewOpenedRequest.create({ source: "home_page" })).catch(
            console.error,
        )
        navigateToWorktrees()
    }, [navigateToWorktrees])

    /**
     * Check if a banner has been dismissed based on its ID or legacy version
     */
    const isBannerDismissed = useCallback(
        (bannerId: string): boolean => {
            // Check if banner is in the dismissed banners list (new approach)
            if (
                dismissedBanners?.some((dismissed: { bannerId: string; dismissedAt: number }) => dismissed.bannerId === bannerId)
            ) {
                return true
            }

            // Legacy version-based tracking (deprecated)
            if (bannerId.startsWith("info-banner")) {
                return (lastDismissedInfoBannerVersion ?? 0) >= 1
            }
            if (bannerId.startsWith("new-model")) {
                return (lastDismissedModelBannerVersion ?? 0) >= 1
            }
            if (bannerId.startsWith("cli-")) {
                return (lastDismissedCliBannerVersion ?? 0) >= 1
            }
            return false
        },
        [dismissedBanners, lastDismissedInfoBannerVersion, lastDismissedModelBannerVersion, lastDismissedCliBannerVersion],
    )

    /**
     * Banner configuration from backend
     */
    const bannerConfig = useMemo((): BannerCardData[] => {
        return BANNER_DATA.filter((banner) => {
            if (isBannerDismissed(banner.id)) {
                return false
            }

            if (banner.isDiracUserOnly !== undefined) {
                return banner.isDiracUserOnly === !!diracUser
            }

            if (banner.platforms && !banner.platforms.includes(getCurrentPlatform())) {
                return false
            }

            return true
        })
    }, [isBannerDismissed, diracUser])

    /**
     * Action handler - maps action types to actual implementations
     */
    const handleBannerAction = useCallback(
        (action: BannerAction) => {
            switch (action.action) {
                case BannerActionType.Link:
                    if (action.arg) {
                        UiServiceClient.openUrl({ value: action.arg }).catch(console.error)
                    }
                    break

                case BannerActionType.SetModel: {
                    const modelId = action.arg || "anthropic/claude-sonnet-4.5"
                    handleFieldsChange({
                        planModeOpenRouterModelId: modelId,
                        actModeOpenRouterModelId: modelId,
                        planModeOpenRouterModelInfo: openRouterModels[modelId],
                        actModeOpenRouterModelInfo: openRouterModels[modelId],
                        planModeApiProvider: "dirac",
                        actModeApiProvider: "dirac",
                    })
                    navigateToSettingsModelPicker({ targetSection: "api-config" })
                    break
                }

                case BannerActionType.ShowAccount:
                    break

                case BannerActionType.ShowApiSettings:
                    if (action.arg) {
                        handleFieldsChange({
                            planModeApiProvider: action.arg as any,
                            actModeApiProvider: action.arg as any,
                        })
                    }
                    navigateToSettings("api-config")
                    break

                case BannerActionType.ShowFeatureSettings:
                    navigateToSettings("features")
                    break

                case BannerActionType.InstallCli:
                    StateServiceClient.installDiracCli({}).catch((error) =>
                        console.error("Failed to initiate CLI installation:", error),
                    )
                    break

                default:
                    console.warn("Unknown banner action:", action.action)
            }
        },
        [handleFieldsChange, openRouterModels, navigateToSettings, navigateToSettingsModelPicker],
    )

    /**
     * Dismissal handler - updates version tracking
     */
    const handleBannerDismiss = useCallback((bannerId: string) => {
        if (bannerId.startsWith("info-banner")) {
            StateServiceClient.updateInfoBannerVersion({ value: 1 }).catch(console.error)
        } else if (bannerId.startsWith("new-model")) {
            StateServiceClient.updateModelBannerVersion({ value: 1 }).catch(console.error)
        } else if (bannerId.startsWith("cli-")) {
            StateServiceClient.updateCliBannerVersion({ value: 1 }).catch(console.error)
        } else {
            StateServiceClient.dismissBanner({ value: bannerId }).catch(console.error)
        }
    }, [])

    /**
     * Build array of active banners for carousel
     * Combines hardcoded banners (bannerConfig) with dynamic banners from extension state
     */
    const activeBanners = useMemo(() => {
        const hardcodedBanners = bannerConfig.map((banner) =>
            convertBannerData(banner, {
                onAction: handleBannerAction,
                onDismiss: handleBannerDismiss,
            }),
        )

        const extensionStateBanners = (banners ?? []).map((banner) =>
            convertBannerData(banner, {
                onAction: handleBannerAction,
                onDismiss: handleBannerDismiss,
            }),
        )

        return [...extensionStateBanners, ...hardcodedBanners]
    }, [bannerConfig, banners, diracUser, handleBannerAction, handleBannerDismiss])

    return (
        <div className="flex flex-col flex-1 w-full h-full p-0 m-0 animate-fade-in">
            <WhatsNewModal
                onBannerAction={handleBannerAction}
                onClose={handleCloseWhatsNewModal}
                open={showWhatsNewModal}
                version={version}
                welcomeBanners={welcomeBanners}
            />
            <div className="overflow-y-auto flex flex-col pb-2.5">
                {!showWhatsNewModal && <BannerCarousel banners={activeBanners} />}
                <div className="flex flex-col">
                    <HistoryPreview showHistoryView={showHistoryView} />
                    {/* Quick launch worktree button */}
                    {isGitRepo && worktreesEnabled?.featureFlag && worktreesEnabled?.user && (
                        <div className="flex flex-col items-center gap-3 mt-2 mb-4 px-5">
                            {currentWorktree && (
                                <Tooltip>
                                    <TooltipTrigger asChild>
                                        <button
                                            className="flex flex-col items-center gap-0.5 text-xs text-[var(--vscode-descriptionForeground)] hover:text-[var(--vscode-foreground)] cursor-pointer bg-transparent border-none p-1 rounded"
                                            onClick={handleWorktreeClick}
                                            type="button">
                                            <div className="flex items-center gap-1.5 text-xs">
                                                <GitBranch className="w-3 h-3 stroke-[2.5] flex-shrink-0" />
                                                <span className="break-all text-center">
                                                    <span className="font-semibold">Current:</span>{" "}
                                                    {currentWorktree.branch || "detached HEAD"}
                                                </span>
                                            </div>
                                            <span className="break-all text-center max-w-[300px]">{currentWorktree.path}</span>
                                        </button>
                                    </TooltipTrigger>
                                    <TooltipContent side="bottom">
                                        View and manage git worktrees. Great for running parallel Dirac tasks.
                                    </TooltipContent>
                                </Tooltip>
                            )}
                        </div>
                    )}
                </div>
                <div className="flex flex-col items-center gap-2 mt-4 px-5 mb-4">
                    <p className="text-xs text-[var(--vscode-descriptionForeground)] text-center">
                        Questions about Dirac? Query the code (v{version}) directly using{" "}
                        <span className="text-[var(--vscode-textLink-foreground)] font-mono">/askDirac</span>
                    </p>
                </div>
            </div>

            {/* Quick launch worktree modal */}
            <CreateWorktreeModal
                onClose={() => setShowCreateWorktreeModal(false)}
                open={showCreateWorktreeModal}
                openAfterCreate={true}
            />
        </div>
    )
}

export default memo(ModularWelcomeSection)
