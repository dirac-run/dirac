import type { ApiProvider } from "@shared/api"
import PROVIDERS from "@shared/providers/providers.json"
import { useState } from "react"
import { useSettingsStore } from "@/features/settings/store/settingsStore"
import { Button } from "@/shared/ui/button"
import ApiOptions from "../ApiOptions"
import { ProviderSetupSummary } from "../ProviderSetupSummary"
import { OpenAiCodexConfiguredDetails } from "../providers/openai-codex/OpenAiCodexConfiguredDetails"
import Section from "../Section"

interface ApiConfigurationSectionProps {
	renderSectionHeader?: (tabId: string) => JSX.Element | null
}

const getProviderLabel = (provider: ApiProvider) => PROVIDERS.list.find((entry) => entry.value === provider)?.label ?? provider

const ApiConfigurationSection = ({ renderSectionHeader }: ApiConfigurationSectionProps) => {
	const { configuredApiProviders, apiConfiguration } = useSettingsStore()
	const [setupView, setSetupView] = useState<{ provider?: ApiProvider } | null>(null)
	const profiles: { name: string; baseUrl: string }[] = apiConfiguration.openAiCompatibleProfiles ?? []
	const providers: ApiProvider[] = profiles.length > 0 && !configuredApiProviders.includes("openai")
		? [...configuredApiProviders, "openai"]
		: configuredApiProviders

	return (
		<div>
			{renderSectionHeader?.("models-api")}
			<Section>
				<p className="m-0 text-xs text-description">
					Provider setup does not change your active model selection. Choose active models in Model configurations.
				</p>
				{setupView ? (
					<>
						<div className="flex flex-wrap items-center justify-between gap-2">
							<h3 className="m-0 text-sm font-medium">
								{setupView.provider ? `${getProviderLabel(setupView.provider)} setup` : "Add provider"}
							</h3>
							<Button type="button" variant="secondary" size="sm" onClick={() => setSetupView(null)}>
								Back to providers
							</Button>
						</div>
						<ApiOptions
							key={setupView.provider ?? "add"}
							initialSetupProvider={setupView.provider}
							currentMode="act"
							intent="setup"
							showModelOptions={false}
						/>
					</>
				) : (
					<>
						<div className="flex flex-wrap items-center justify-between gap-2">
							<h3 className="m-0 text-sm font-medium">Configured providers</h3>
							<Button type="button" size="sm" onClick={() => setSetupView({})}>
								+ Add provider
							</Button>
						</div>
						{providers.length === 0 ? (
							<p className="m-0 text-sm text-description">No providers configured yet. Add a provider to get started.</p>
						) : (
							<ul aria-label="Configured providers" className="m-0 list-none divide-y divide-(--vscode-panel-border) p-0">
								{providers.map((provider) => (
									<li className="py-3" key={provider}>
										<div className="flex flex-wrap items-center justify-between gap-2">
											<div className="min-w-0 break-words">
												<span className="text-sm font-medium">{getProviderLabel(provider)}</span>
												<ProviderSetupSummary provider={provider} />
											</div>
											<Button
												type="button"
												variant="secondary"
												size="sm"
												aria-label={`Edit ${getProviderLabel(provider)} setup`}
												onClick={() => setSetupView({ provider })}>
												Edit setup
											</Button>
										</div>
										{provider === "openai-codex" && <OpenAiCodexConfiguredDetails />}
										{provider === "openai" && profiles.length > 0 && (
											<ul aria-label="OpenAI Compatible profiles" className="mt-2 list-none space-y-1 pl-3">
												{profiles.map((profile) => (
													<li key={profile.name} className="flex flex-wrap justify-between gap-x-2 text-xs">
														<span className="min-w-0 break-words">{profile.name}</span>
														<span className="min-w-0 break-all text-description">{profile.baseUrl}</span>
													</li>
												))}
											</ul>
										)}
									</li>
								))}
							</ul>
						)}
					</>
				)}
			</Section>
		</div>
	)
}

export default ApiConfigurationSection
