import React from "react"
import { Box, Text } from "ink"
import { StateManager } from "@/core/storage/StateManager"
import { getProviderMembershipState } from "@/core/storage/providerMembership"
import { getProviderLabel, getValidCliProviders } from "../../utils/providers"
import { SearchableList } from "../SearchableList"
import { theme } from "../../constants/theme"
import type { ListItem } from "./types"

export const ApiProvidersPage: React.FC<{ isActive: boolean; onProvider: (id: string) => void; onEndpoint: (name: string) => void; onLegacyEndpoint: () => void; onCancel: () => void; actions: ListItem[]; onAction: (item: ListItem) => void }> = ({ isActive, onProvider, onEndpoint, onLegacyEndpoint, actions, onAction }) => {
	const state = StateManager.get()
	const providers = getProviderMembershipState(state).configuredApiProviders
	const profiles = state.getSystemDefaultSettingsKey("openAiCompatibleProfiles")
	const legacyBaseUrl = state.getSystemDefaultSettingsKey("openAiBaseUrl")
	const hasLegacyApiKey = !!(state.getSecretKey("openAiCompatibleCustomApiKey") || state.getSecretKey("openAiApiKey"))
	const hasLegacySetup = !!legacyBaseUrl || hasLegacyApiKey
	return <Box flexDirection="column">
		{providers.filter((id) => id !== "openai" || (!profiles.length && !hasLegacySetup)).map((id) => <Text key={id}>{getProviderLabel(id)} · Saved setup</Text>)}
		{hasLegacySetup && <Text>Saved endpoint · {legacyBaseUrl || "Default URL"} · {hasLegacyApiKey ? "API key saved" : "Keyless"}</Text>}
		{profiles.map((profile) => <Text key={profile.name}>{profile.name} · {profile.baseUrl} · {profile.apiKey ? "API key saved" : "Keyless"}</Text>)}
		<Text color={theme.muted}>Configure provider or endpoint (type to filter)</Text>
		<SearchableList isActive={isActive} items={[
			...actions.map((item) => ({ id: `action:${item.key}`, label: `${item.label} ${item.value}` })),
			...(hasLegacySetup ? [{ id: "legacy-openai", label: `Edit saved endpoint · ${legacyBaseUrl || "Default URL"}` }] : []),
			...profiles.map((profile) => ({ id: `endpoint:${profile.name}`, label: `Edit ${profile.name}` })),
			...getValidCliProviders().map((id) => ({ id, label: id === "openai" ? "New named OpenAI-compatible endpoint" : getProviderLabel(id) })),
		]} onSelect={(item) => {
			if (item.id === "legacy-openai") { onLegacyEndpoint(); return }
			if (item.id.startsWith("action:")) { onAction(actions.find((action) => action.key === item.id.slice(7))!); return }
			if (item.id.startsWith("endpoint:")) onEndpoint(item.id.slice(9)); else onProvider(item.id)
		}} />
	</Box>
}
