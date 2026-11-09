import { SETTINGS_HELP } from "@shared/settings-presentation"
import { VSCodeCheckbox } from "@vscode/webview-ui-toolkit/react"
import React, { useRef } from "react"
import { useClickAway } from "react-use"
import { useAppStore } from "@/app/store/appStore"
import { useSettingsStore } from "@/features/settings/store/settingsStore"
import { useAutoApproveActions } from "@/shared/hooks/useAutoApproveActions"
import { useAutoApproveAll } from "@/shared/hooks/useAutoApproveAll"
import { Button } from "@/shared/ui/button"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/shared/ui/tooltip"
import { updateSetting } from "@/features/settings/components/utils/settingsHandlers"
import AutoApproveMenuItem from "./AutoApproveMenuItem"
import { ACTION_METADATA, NOTIFICATIONS_SETTING } from "./constants"

interface AutoApproveModalProps {
	isVisible: boolean
	setIsVisible: (visible: boolean) => void
	buttonRef: React.RefObject<HTMLButtonElement>
}

const AutoApproveModal = ({ isVisible, setIsVisible, buttonRef }: AutoApproveModalProps) => {
	const navigateToSettings = useAppStore((state) => state.navigateToSettings)
	const {
		autoApproveAllToggled,
		autoApproveAllUpdateError,
		pendingAutoApproveAllToggled,
		remoteConfigSettings,
		strictPlanModeEnabled,
		yoloModeToggled,
	} = useSettingsStore()
	const { isChecked, updateAction, updateNotifications } = useAutoApproveActions()
	const { updateAutoApproveAll } = useAutoApproveAll()
	const modalRef = useRef<HTMLDivElement>(null)
	const isYoloRemoteLocked = remoteConfigSettings?.yoloModeToggled !== undefined
	const effectiveYoloMode = remoteConfigSettings?.yoloModeToggled ?? yoloModeToggled

	useClickAway(modalRef, (event) => {
		if (!buttonRef.current?.contains(event.target as Node)) setIsVisible(false)
	})

	if (!isVisible) return null

	return (
		<div className="max-h-[60vh] overflow-y-auto overscroll-contain px-3.5 pb-3" ref={modalRef}>
			<p className="mb-2.5 mt-0 text-xs text-muted-foreground">
				Let Dirac take these actions without asking for approval.
			</p>
			<p className="mb-2.5 mt-0 text-xs text-muted-foreground">
				Read project files also permits model-requested conversation condensing. Automatic threshold-triggered condensing is controlled separately by Auto-condense conversations.
			</p>

			<div className="grid grid-cols-1 gap-x-1 min-[500px]:grid-cols-2">
				{ACTION_METADATA.map((action) => (
					<AutoApproveMenuItem
						action={action}
						disabled={autoApproveAllToggled || effectiveYoloMode}
						isChecked={isChecked}
						key={action.id}
						onToggle={updateAction}
					/>
				))}
			</div>

			<div className="my-2 border-t border-muted-foreground/10" />

			<AutoApproveMenuItem
				action={NOTIFICATIONS_SETTING}
				isChecked={isChecked}
				onToggle={updateNotifications}
			/>
			<div className="px-0.5 py-0.5">
				<VSCodeCheckbox
					checked={strictPlanModeEnabled}
					onChange={(event: any) => updateSetting("strictPlanModeEnabled", event.target.checked === true)}>
					<span className="text-sm">Strict Plan Mode</span>
				</VSCodeCheckbox>
			</div>

			<div className="my-2 border-t border-muted-foreground/10" />

			<div className="mb-1 px-0.5">
				<Tooltip>
					<TooltipTrigger asChild>
						<div className="inline-flex" tabIndex={0}>
							<VSCodeCheckbox
								checked={autoApproveAllToggled}
								disabled={effectiveYoloMode || pendingAutoApproveAllToggled !== undefined}
								onChange={(event: any) =>
									void updateAutoApproveAll(event.target.checked === true)
								}>
								<span className="text-sm">Approve All</span>
							</VSCodeCheckbox>
						</div>
					</TooltipTrigger>
					<TooltipContent className="max-w-sm">{SETTINGS_HELP.approveAll}</TooltipContent>
				</Tooltip>
				{autoApproveAllUpdateError && (
					<p className="mb-1 mt-1 text-xs text-(--vscode-errorForeground)">{autoApproveAllUpdateError}</p>
				)}
			</div>

			<div className="px-0.5">
				<Tooltip>
					<TooltipTrigger asChild>
						<div className="inline-flex items-center gap-2" tabIndex={isYoloRemoteLocked ? 0 : undefined}>
							<VSCodeCheckbox
								checked={effectiveYoloMode}
								disabled={isYoloRemoteLocked}
								onChange={(event: any) =>
									updateSetting("yoloModeToggled", event.target.checked === true)
								}>
								<span className="text-sm">YOLO Mode</span>
							</VSCodeCheckbox>
							{isYoloRemoteLocked && <i className="codicon codicon-lock text-description text-sm" />}
						</div>
					</TooltipTrigger>
					<TooltipContent hidden={!isYoloRemoteLocked}>{SETTINGS_HELP.managedSetting}</TooltipContent>
				</Tooltip>
				<p className="mb-1 mt-1 text-xs text-(--vscode-errorForeground)">{SETTINGS_HELP.yolo}</p>
				<p className="m-0 text-xs text-muted-foreground">{SETTINGS_HELP.yoloPrecedence}</p>
			</div>

			<Button
				className="mt-3"
				onClick={() => {
					setIsVisible(false)
					navigateToSettings("approvals")
				}}
				size="sm"
				variant="secondary">
				More approval settings…
			</Button>
		</div>
	)
}

export default AutoApproveModal
