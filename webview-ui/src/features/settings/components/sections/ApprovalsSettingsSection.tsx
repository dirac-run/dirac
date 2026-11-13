import { SETTINGS_HELP } from "@shared/settings-presentation"
import { useAppStore } from "@/app/store/appStore"
import { VSCodeCheckbox } from "@vscode/webview-ui-toolkit/react"
import { useSettingsStore } from "@/features/settings/store/settingsStore"
import { useAutoApproveActions } from "@/shared/hooks/useAutoApproveActions"
import { useAutoApproveAll } from "@/shared/hooks/useAutoApproveAll"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/shared/ui/tooltip"
import { Button } from "@/shared/ui/button"
import { getProviderLabel } from "@/shared/lib/getConfiguredProviders"
import AutoApproveMenuItem from "@/features/modular-ui/chat/components/AutoApprove/AutoApproveMenuItem"
import { ACTION_METADATA, NOTIFICATIONS_SETTING } from "@/features/modular-ui/chat/components/AutoApprove/constants"
import Section from "../Section"
import UserApprovedCommandsSection from "./UserApprovedCommandsSection"
import { updateSetting } from "../utils/settingsHandlers"

interface ApprovalsSettingsSectionProps {
	renderSectionHeader: (tabId: string) => JSX.Element | null
}

const ApprovalsSettingsSection = ({ renderSectionHeader }: ApprovalsSettingsSectionProps) => {
	const navigateToSettings = useAppStore((state) => state.navigateToSettings)
	const {
		autoApproveAllToggled,
		autoApproveAllUpdateError,
		pendingAutoApproveAllToggled,
		remoteConfigSettings,
		strictPlanModeEnabled,
		utilityModelPermissionPolicy,
		utilityModelSelection,
		utilityModelUsePermissionHandling,
		yoloModeToggled,
	} = useSettingsStore()
	const { isChecked, updateAction, updateNotifications } = useAutoApproveActions()
	const { updateAutoApproveAll } = useAutoApproveAll()
	const isYoloRemoteLocked = remoteConfigSettings?.yoloModeToggled !== undefined
	const effectiveYoloMode = isYoloRemoteLocked ? remoteConfigSettings.yoloModeToggled : yoloModeToggled
	const utilityModelId = utilityModelSelection?.modelId.trim()
	const missingUtilityConfiguration = [
		!utilityModelId && "Utility Model",
		!utilityModelPermissionPolicy.trim() && "permission policy",
	]
		.filter(Boolean)
		.join(" and ")
	const utilityApprovalStatus = !utilityModelUsePermissionHandling
		? "Disabled"
		: missingUtilityConfiguration
			? `Not ready — missing ${missingUtilityConfiguration}`
			: "Enabled"

	return (
		<div className="mb-2">
			{renderSectionHeader("approvals")}
			<Section>
				<p className="m-0 text-sm text-description">
					Control which actions Dirac may take without requesting confirmation.
				</p>

				<div className="rounded border border-(--vscode-widget-border) p-3" id="auto-approve-actions">
					<h3 className="mt-0 text-sm font-medium">Auto-approve selected actions</h3>
					{ACTION_METADATA.map((action) => (
						<AutoApproveMenuItem
							action={action}
							disabled={autoApproveAllToggled || effectiveYoloMode}
							isChecked={isChecked}
							key={action.id}
							onToggle={updateAction}
						/>
					))}
					<AutoApproveMenuItem
						action={NOTIFICATIONS_SETTING}
						disabled={false}
						isChecked={isChecked}
						onToggle={async (action, checked) => updateNotifications(action, checked)}
					/>
				</div>

				<div className="rounded border border-(--vscode-widget-border) p-3" id="approval-policies">
					<div className="mb-3">
						<VSCodeCheckbox
							checked={strictPlanModeEnabled}
							onChange={(event: any) => updateSetting("strictPlanModeEnabled", event.target.checked === true)}>
							Strict Plan Mode
						</VSCodeCheckbox>
						<p className="ml-6 mt-1 text-xs text-description">
							Block file-changing tools while in Plan Mode. Inspection and planning remain available until you
							explicitly switch to Act.
						</p>
					</div>
				</div>

				<section
					aria-labelledby="utility-approvals-heading"
					className="rounded border border-(--vscode-widget-border) p-3"
					id="utility-approvals">
					<div className="flex flex-wrap items-center justify-between gap-2">
						<h3 className="m-0 text-sm font-medium" id="utility-approvals-heading">
							AI-assisted approvals
						</h3>
						<Button
							className="max-w-full whitespace-normal"
							onClick={() => navigateToSettings("utility-model")}
							size="sm"
							type="button"
							variant="secondary">
							Configure Utility Model
						</Button>
					</div>
					<p className="mb-2 mt-2 text-sm">
						Use your Utility Model and permission policy to review tool permission requests.
					</p>
					<dl className="m-0 grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 text-sm">
						<dt className="text-description">Status</dt>
						<dd className="m-0 break-words font-medium">{utilityApprovalStatus}</dd>
						<dt className="text-description">Provider</dt>
						<dd className="m-0 break-words">
							{utilityModelSelection ? getProviderLabel(utilityModelSelection.provider) : "Not selected"}
							{utilityModelSelection?.openAiProfileName && ` (${utilityModelSelection.openAiProfileName})`}
						</dd>
						<dt className="text-description">Model</dt>
						<dd className="m-0 break-words">{utilityModelId || "Not selected"}</dd>
						<dt className="text-description">Permission policy</dt>
						<dd className="m-0">{utilityModelPermissionPolicy.trim() ? "Configured" : "Not configured"}</dd>
					</dl>
					{!utilityModelUsePermissionHandling && (
						<p className="mb-0 mt-2 text-xs text-description">
							Enable “Handle permission requests” in Utility Model to use AI-assisted approvals.
						</p>
					)}
					<p className="mb-0 mt-2 text-xs text-description">{SETTINGS_HELP.utilityPermissionFallback}</p>
				</section>

				<div className="rounded border border-(--vscode-widget-border) p-3" id="approve-all">
					<Tooltip>
						<TooltipTrigger asChild>
							<div className="inline-flex" tabIndex={0}>
								<VSCodeCheckbox
									checked={autoApproveAllToggled}
									disabled={effectiveYoloMode || pendingAutoApproveAllToggled !== undefined}
									onChange={(event: any) => void updateAutoApproveAll(event.target.checked === true)}>
									Approve All
								</VSCodeCheckbox>
							</div>
						</TooltipTrigger>
						<TooltipContent className="max-w-sm">{SETTINGS_HELP.approveAll}</TooltipContent>
					</Tooltip>
					{autoApproveAllUpdateError && (
						<p className="text-xs text-(--vscode-errorForeground)">{autoApproveAllUpdateError}</p>
					)}
				</div>

				<div className="rounded border border-(--vscode-inputValidation-errorBorder) p-3" id="yolo-mode">
					<Tooltip>
						<TooltipTrigger asChild>
							<div className="inline-flex items-center gap-2" tabIndex={isYoloRemoteLocked ? 0 : undefined}>
								<VSCodeCheckbox
									checked={effectiveYoloMode}
									disabled={isYoloRemoteLocked}
									onChange={(event: any) => updateSetting("yoloModeToggled", event.target.checked === true)}>
									YOLO Mode
								</VSCodeCheckbox>
								{isYoloRemoteLocked && <i className="codicon codicon-lock text-description text-sm" />}
							</div>
						</TooltipTrigger>
						<TooltipContent hidden={!isYoloRemoteLocked}>{SETTINGS_HELP.managedSetting}</TooltipContent>
					</Tooltip>
					<p className="mb-1 mt-2 text-xs text-(--vscode-errorForeground)">{SETTINGS_HELP.yolo}</p>
					<p className="m-0 text-xs text-description">{SETTINGS_HELP.yoloPrecedence}</p>
				</div>
			</Section>
			<UserApprovedCommandsSection renderSectionHeader={() => null} />
		</div>
	)
}

export default ApprovalsSettingsSection
