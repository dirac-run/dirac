import { useState } from "react"
import type { ApiProvider } from "@shared/api"
import PROVIDERS from "@shared/providers/providers.json"
import { useSettingsStore } from "@/features/settings/store/settingsStore"
import ApiOptions from "../ApiOptions"
import Section from "../Section"
import { ProviderSetupSummary } from "../ProviderSetupSummary"

interface ApiConfigurationSectionProps {
	renderSectionHeader?: (tabId: string) => JSX.Element | null
}

const ApiConfigurationSection = ({ renderSectionHeader }: ApiConfigurationSectionProps) => {
	const { configuredApiProviders, apiConfiguration } = useSettingsStore()
	const [editingProvider, setEditingProvider] = useState<ApiProvider>()
	const profiles: { name: string; baseUrl: string }[] = apiConfiguration?.openAiCompatibleProfiles ?? []
	return <div>
		{renderSectionHeader?.("models-api")}
		<Section>
			<div className="divide-y divide-(--vscode-panel-border)">
				{configuredApiProviders.map((provider) => <div className="flex items-center justify-between py-2" key={provider}>
					<div><span>{PROVIDERS.list.find((entry) => entry.value === provider)?.label ?? provider}</span><ProviderSetupSummary provider={provider} /></div>
					<button type="button" onClick={() => setEditingProvider(provider)}>Edit setup</button>
				</div>)}
				{profiles.map((profile) => <div key={profile.name} className="flex justify-between gap-2 py-1 text-xs">
					<span>{profile.name}</span><span className="text-description">{profile.baseUrl}</span>
				</div>)}
			</div>
			<div className="mt-4">
				<h3 className="text-sm font-medium">Add or configure a provider</h3>
				<ApiOptions key={editingProvider ?? "add"} initialSetupProvider={editingProvider} currentMode="act" intent="setup" showModelOptions={false} />
			</div>
		</Section>
	</div>
}

export default ApiConfigurationSection
