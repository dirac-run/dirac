import { BannerAction, BannerCardData } from "@shared/dirac/banner"
import React, { useCallback } from "react"
import { useMount } from "react-use"
import DiscordIcon from "@/assets/DiscordIcon"
import GitHubIcon from "@/assets/GitHubIcon"
import LinkedInIcon from "@/assets/LinkedInIcon"
import RedditIcon from "@/assets/RedditIcon"
import XIcon from "@/assets/XIcon"
import { useSettingsStore } from "@/features/settings/store/settingsStore"
import { Dialog, DialogContent } from "@/shared/ui/dialog"
import WhatsNewItems from "@/shared/ui/WhatsNewItems"
import { useApiConfigurationHandlers } from "../../features/settings/components/utils/useApiConfigurationHandlers"

interface WhatsNewModalProps {
	open: boolean
	onClose: () => void
	version: string
	welcomeBanners?: BannerCardData[]
	onBannerAction?: (action: BannerAction) => void
}

export const WhatsNewModal: React.FC<WhatsNewModalProps> = ({ open, onClose, version, welcomeBanners, onBannerAction }) => {
	const { openRouterModels, refreshOpenRouterModels, navigateToSettingsModelPicker } = useSettingsStore()
	const { handleFieldsChange } = useApiConfigurationHandlers()

	// Get latest model list in case user hits shortcut button to set model
	useMount(refreshOpenRouterModels)

	const navigateToModelPicker = useCallback(
		(modelId?: string) => {
			// Switch to Dirac provider first so the model picker tab works
			// Optionally also set the model if provided
			const updates: Record<string, any> = {
				planModeApiProvider: "dirac",
				actModeApiProvider: "dirac",
			}
			if (modelId) {
				updates.planModeOpenRouterModelId = modelId
				updates.actModeOpenRouterModelId = modelId
				updates.planModeOpenRouterModelInfo = openRouterModels[modelId]
				updates.actModeOpenRouterModelInfo = openRouterModels[modelId]
			}
			handleFieldsChange(updates)
			onClose()
			navigateToSettingsModelPicker({ targetSection: "api-config" })
		},
		[handleFieldsChange, navigateToSettingsModelPicker, onClose, openRouterModels],
	)

	const inlineCodeStyle: React.CSSProperties = {
		backgroundColor: "var(--vscode-textCodeBlock-background)",
		padding: "2px 6px",
		borderRadius: "3px",
		fontFamily: "var(--vscode-editor-font-family)",
		fontSize: "0.9em",
	}

	return (
		<Dialog
			onOpenChange={(isOpen) => {
				if (!isOpen) onClose()
			}}
			open={open}>
			<DialogContent
				aria-describedby="whats-new-description"
				aria-labelledby="whats-new-title"
				className="pt-5 px-5 pb-4 gap-0"
				hideClose={true}>
				<div id="whats-new-description">
					<h2
						className="text-lg font-semibold mb-3 pr-6"
						id="whats-new-title"
						style={{ color: "var(--vscode-editor-foreground)" }}>
						<div className="flex items-center justify-between">
							<span>🎉 New in v{version}</span>
							<button
								aria-label="Close"
								className="p-1 hover:bg-[var(--vscode-toolbar-hoverBackground)] rounded-sm transition-colors cursor-pointer"
								onClick={onClose}
								type="button">
								<span className="codicon codicon-close text-lg" />
							</button>
						</div>
					</h2>

					<WhatsNewItems
						inlineCodeStyle={inlineCodeStyle}
						onBannerAction={onBannerAction}
						onClose={onClose}
						onNavigateToModelPicker={navigateToModelPicker}
						welcomeBanners={welcomeBanners}
					/>

					{/* Social Icons Section */}
					<div className="flex flex-col items-center gap-3 mt-4 pt-4 border-t border-[var(--vscode-widget-border)]">
						{/* Icon Row */}
						<div className="flex items-center gap-4">
							{/* X/Twitter */}
							<a
								aria-label="Follow us on X"
								className="text-[var(--vscode-foreground)] hover:text-[var(--vscode-textLink-activeForeground)] transition-colors"
								href="https://x.com/dirac"
								rel="noopener noreferrer"
								target="_blank">
								<XIcon />
							</a>

							{/* Discord */}
							<a
								aria-label="Join our Discord"
								className="text-[var(--vscode-foreground)] hover:text-[var(--vscode-textLink-activeForeground)] transition-colors"
								href="https://discord.gg/mWkzrF4h"
								rel="noopener noreferrer"
								target="_blank">
								<DiscordIcon />
							</a>

							{/* GitHub */}
							<a
								aria-label="Star us on GitHub"
								className="text-[var(--vscode-foreground)] hover:text-[var(--vscode-textLink-activeForeground)] transition-colors"
								href="https://github.com/dirac-run/dirac"
								rel="noopener noreferrer"
								target="_blank">
								<GitHubIcon />
							</a>

							{/* Reddit */}
							<a
								aria-label="Join our subreddit"
								className="text-[var(--vscode-foreground)] hover:text-[var(--vscode-textLink-activeForeground)] transition-colors"
								href="https://www.reddit.com/r/dirac/"
								rel="noopener noreferrer"
								target="_blank">
								<RedditIcon />
							</a>

							{/* LinkedIn */}
							<a
								aria-label="Follow us on LinkedIn"
								className="text-[var(--vscode-foreground)] hover:text-[var(--vscode-textLink-activeForeground)] transition-colors"
								href="https://www.linkedin.com/company/diracbot/"
								rel="noopener noreferrer"
								target="_blank">
								<LinkedInIcon />
							</a>
						</div>

						{/* GitHub Star CTA */}
						<p className="text-sm text-center" style={{ color: "var(--vscode-descriptionForeground)" }}>
							Please support Dirac by{" "}
							<a
								href="https://github.com/dirac-run/dirac"
								rel="noopener noreferrer"
								style={{ color: "var(--vscode-textLink-foreground)" }}
								target="_blank">
								starring us on GitHub
							</a>
							.
						</p>
					</div>
				</div>
			</DialogContent>
		</Dialog>
	)
}

export default WhatsNewModal
