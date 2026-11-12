import { SETTINGS_HELP } from "@shared/settings-presentation"
import { useSettingsStore } from "@/features/settings/store/settingsStore"
import { MainModelSelection } from "../MainModelSelection"
import Section from "../Section"
import UtilityModelSelection from "../UtilityModelSelection"
import { SubagentRolesSection } from "../SubagentRolesSection"
import { syncModeConfigurations } from "../utils/providerUtils"
import { persistSetting } from "../utils/settingsHandlers"
import { useApiConfigurationHandlers } from "../utils/useApiConfigurationHandlers"

interface UtilityModelSectionProps {
	renderSectionHeader?: (tabId: string) => JSX.Element | null
}

const UtilityModelSection = ({ renderSectionHeader }: UtilityModelSectionProps) => {
	const { mode: storedMode, apiConfiguration, planActSeparateModelsSetting } = useSettingsStore()
	const mode = storedMode === "plan" ? "plan" : "act"
	const { handleFieldsChange } = useApiConfigurationHandlers()
	const apiConfigurationError = useSettingsStore((state) => state.apiConfigurationError)
	return (
		<div>
			{renderSectionHeader?.("utility-model")}
			<Section>
				{apiConfigurationError && (
					<p role="alert" className="text-xs text-error">
						Could not save model configuration: {apiConfigurationError}
					</p>
				)}
				<label className="mb-2 flex items-center gap-2 text-xs">
					<input
						type="checkbox"
						checked={planActSeparateModelsSetting}
						onChange={async (event) => {
							const separate = event.target.checked
							if (!separate) await syncModeConfigurations(apiConfiguration, mode, handleFieldsChange)
							await persistSetting("planActSeparateModelsSetting", separate)
						}}
					/>
					Use separate models for Plan and Act
				</label>
				{planActSeparateModelsSetting ? (
					<>
						<div className="space-y-2">
							<p className="text-xs text-description">{SETTINGS_HELP.planModel}</p>
							<MainModelSelection mode="plan" label="Plan" />
						</div>
						<div className="space-y-2">
							<p className="text-xs text-description">{SETTINGS_HELP.actModel}</p>
							<MainModelSelection mode="act" label="Act" />
						</div>
					</>
				) : (
					<div className="space-y-2">
						<p className="text-xs text-description">{SETTINGS_HELP.planAndActModel}</p>
						<MainModelSelection mode={mode} label="Plan and Act" />
					</div>
				)}
				<UtilityModelSelection />
				<SubagentRolesSection />
			</Section>
		</div>
	)
}

export default UtilityModelSection
