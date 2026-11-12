import type { ModelProviderSelection } from "@shared/api"
import { supportsCustomModelId } from "@shared/customModelIds"
import { convertModelProviderSelectionToProto } from "@shared/proto-conversions/models/api-configuration-conversion"
import { SETTINGS_HELP } from "@shared/settings-presentation"
import { VSCodeCheckbox } from "@vscode/webview-ui-toolkit/react"
import { useEffect, useState } from "react"
import { useSettingsStore } from "@/features/settings/store/settingsStore"
import { ModelSelectionEditor } from "./ModelSelectionEditor"
import { persistSetting, updateSetting } from "./utils/settingsHandlers"

const USE_CASES = [
	{
		field: "utilityModelUseCondense" as const,
		label: "Condense conversations",
		description: "Summarize long conversations before their context limit is reached.",
	},
	{
		field: "utilityModelUseGenerateCommitMessage" as const,
		label: "Generate commit messages",
		description: "Generate Git commit messages in VS Code.",
	},
	{
		field: "utilityModelUsePermissionHandling" as const,
		label: "Handle permission requests",
		description: "Apply your policy to approve tool permission requests or escalate them to you.",
	},
]

const UtilityModelSelection = () => {
	const {
		utilityModelSelection,
		utilityModelUseCondense,
		utilityModelUseGenerateCommitMessage,
		utilityModelUsePermissionHandling,
		utilityModelPermissionPolicy,
	} = useSettingsStore()
	const [pendingSelection, setPendingSelection] = useState<ModelProviderSelection | undefined>()
	useEffect(() => setPendingSelection(undefined), [utilityModelSelection])
	const [permissionPolicy, setPermissionPolicy] = useState(utilityModelPermissionPolicy)
	useEffect(() => setPermissionPolicy(utilityModelPermissionPolicy), [utilityModelPermissionPolicy])
	const [permissionPolicySaving, setPermissionPolicySaving] = useState(false)
	const [permissionPolicySaveError, setPermissionPolicySaveError] = useState(false)
	const selection = pendingSelection ?? utilityModelSelection
	const anyUseCaseEnabled = utilityModelUseCondense || utilityModelUseGenerateCommitMessage || utilityModelUsePermissionHandling

	const persistSelection = (nextSelection: ModelProviderSelection) => {
		setPendingSelection(nextSelection)
		updateSetting("utilityModelSelection", convertModelProviderSelectionToProto(nextSelection))
	}

	const persistPermissionPolicy = async () => {
		if (permissionPolicy === utilityModelPermissionPolicy) return
		setPermissionPolicySaving(true)
		setPermissionPolicySaveError(false)
		try {
			await persistSetting("utilityModelPermissionPolicy", permissionPolicy)
		} catch {
			setPermissionPolicySaveError(true)
		} finally {
			setPermissionPolicySaving(false)
		}
	}

	return (
		<div className="space-y-2">
			<p className="text-xs text-description">{SETTINGS_HELP.utilityModel}</p>
			<ModelSelectionEditor
				label="Utility"
				selection={selection}
				onChange={persistSelection}
				allowCustomModelId={supportsCustomModelId}
			/>

			<div className="flex flex-wrap items-center gap-x-4 gap-y-1 py-1">
				<span className="text-xs font-medium text-description">Use utility model for</span>
				{USE_CASES.map(({ field, label, description }) => (
					<div key={field} title={description}>
						<VSCodeCheckbox
							aria-label={label}
							checked={
								field === "utilityModelUseCondense"
									? utilityModelUseCondense
									: field === "utilityModelUseGenerateCommitMessage"
										? utilityModelUseGenerateCommitMessage
										: utilityModelUsePermissionHandling
							}
							onChange={(event: any) => updateSetting(field, event.target.checked === true)}>
							{label}
						</VSCodeCheckbox>
					</div>
				))}
			</div>

			{utilityModelUsePermissionHandling && (
				<div className="space-y-2 rounded border border-(--vscode-panel-border) p-3">
					<label className="block text-sm font-medium" htmlFor="utility-permission-policy">
						Permission policy
					</label>
					<textarea
						aria-label="Permission policy"
						className="min-h-24 w-full resize-y rounded-sm border border-(--vscode-input-border) bg-(--vscode-input-background) px-2 py-1 text-sm text-(--vscode-input-foreground)"
						id="utility-permission-policy"
						placeholder="Allow file edits in this repository. Ask before network calls. Never allow operations in secrets/."
						value={permissionPolicy}
						onChange={(event) => setPermissionPolicy(event.target.value)}
						onBlur={() => void persistPermissionPolicy()}
					/>
					<p className="text-xs text-description">{SETTINGS_HELP.utilityPermissionFallback}</p>
					{permissionPolicySaving && <p className="text-xs text-description">Saving permission policy...</p>}
					{permissionPolicySaveError && (
						<p className="text-xs text-(--vscode-errorForeground)">
							Permission policy was not saved. Blur the field to retry.
						</p>
					)}
					{permissionPolicy.trim() === "" && (
						<p className="text-xs text-(--vscode-editorWarning-foreground)">
							Add a policy before automatic permission handling can run.
						</p>
					)}
				</div>
			)}

			{anyUseCaseEnabled && !selection?.modelId && (
				<p className="rounded border border-(--vscode-inputValidation-warningBorder) px-2 py-1 text-xs text-(--vscode-editorWarning-foreground)">
					Select a Utility Model provider and model before this use case can run.
				</p>
			)}

			<p className="text-xs text-description">{SETTINGS_HELP.utilityDisclosure}</p>
		</div>
	)
}

export default UtilityModelSelection
