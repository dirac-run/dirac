import React, { useState } from "react"
import { Box, Text, useInput } from "ink"
import type { ApiProvider, ModelInfo, ModelProviderSelection, OpenAiCompatibleProfile } from "@shared/api"
import { ANTHROPIC_MAX_THINKING_BUDGET, ANTHROPIC_MIN_THINKING_BUDGET, getModelInfoForProvider } from "@shared/api"
import { getReasoningEffortOptionsForModel } from "@shared/utils/reasoning-support"
import { getProviderMembershipState } from "@/core/storage/providerMembership"
import { StateManager } from "@/core/storage/StateManager"
import type { Controller } from "@/core/controller"
import { getProviderLabel, getValidCliProviders } from "../../utils/providers"
import { ModelPicker, CUSTOM_MODEL_ID } from "../ModelPicker"
import { BedrockCustomFlowPage } from "./subpages/SetupPages"
import { SearchableList } from "../SearchableList"
import { theme } from "../../constants/theme"
const EMPTY_HEADERS: Record<string, string> = {}

interface Props {
	value?: ModelProviderSelection
	controller?: Controller
	onSave: (selection: ModelProviderSelection) => Promise<void>
	onCancel: () => void
}
interface ProviderChoice { id: string; label: string; provider: ApiProvider; openAiProfileName?: string }
export function configuredModelChoices(providers: ApiProvider[], profiles: OpenAiCompatibleProfile[], legacyBaseUrl?: string, hasLegacyApiKey = false): ProviderChoice[] {
	return providers.flatMap<ProviderChoice>((provider) => provider === "openai" && profiles.length
		? [
			...(legacyBaseUrl || hasLegacyApiKey ? [{ id: provider, label: `Saved endpoint · ${legacyBaseUrl || "Default URL"}`, provider }] : []),
			...profiles.map((profile) => ({ id: `endpoint:${profile.name}`, label: profile.name, provider, openAiProfileName: profile.name })),
		]
		: [{ id: provider, label: getProviderLabel(provider), provider }])
}

/** Changing a model drops the previous model's reasoning settings, not its endpoint identity. */
export function selectionForModel(previous: ModelProviderSelection, modelId: string, modelInfo?: ModelInfo): ModelProviderSelection {
	return {
		provider: previous.provider, openAiProfileName: previous.openAiProfileName, modelId,
		modelInfo: modelInfo ?? getModelInfoForProvider(previous.provider, modelId),
		...(previous.provider === "vscode-lm" ? { vsCodeLmModelSelector: previous.vsCodeLmModelSelector } : {}),
	}
}

/** Controlled input: callers own persistence and main-task versus independent binding. */
export const ModelSelectionEditor: React.FC<Props> = ({ value, controller, onSave, onCancel }) => {
	const state = StateManager.get()
	const profiles = state.getSystemDefaultSettingsKey("openAiCompatibleProfiles")
	const legacyBaseUrl = state.getSystemDefaultSettingsKey("openAiBaseUrl")
	const choices = configuredModelChoices(getProviderMembershipState(state).configuredApiProviders.filter((provider) => getValidCliProviders().includes(provider)), profiles, legacyBaseUrl, !!(state.getSecretKey("openAiCompatibleCustomApiKey") || state.getSecretKey("openAiApiKey")))
	const [selection, setSelection] = useState<ModelProviderSelection | undefined>(value)
	const [step, setStep] = useState<"provider" | "model" | "custom" | "options" | "budget" | "bedrock">(value ? "options" : "provider")
	const [text, setText] = useState("")
	const [error, setError] = useState("")
	const [busy, setBusy] = useState(false)
	const profile = profiles.find((candidate) => candidate.name === selection?.openAiProfileName)
	const info = selection?.modelInfo ?? (selection ? getModelInfoForProvider(selection.provider, selection.awsBedrockCustomModelBaseId ?? selection.modelId) : undefined)
	// Unknown custom IDs do not acquire reasoning capabilities merely from their spelling.
	const efforts = info ? getReasoningEffortOptionsForModel(selection?.modelId, info) : []
	const showBudget = !!(info?.thinkingConfig || info?.supportsReasoning) && !info?.thinkingAlwaysOn && !efforts.length && !info?.thinkingConfig?.supportsThinkingLevel
	const maxBudget = info?.thinkingConfig?.maxBudget ?? ANTHROPIC_MAX_THINKING_BUDGET
	const save = async () => {
		if (!selection?.modelId.trim() || selection.modelId === CUSTOM_MODEL_ID) { setError("Select a model"); return }
		setBusy(true); setError("")
		try { await onSave(selection) } catch (failure) { setError(failure instanceof Error ? failure.message : String(failure)) }
		finally { setBusy(false) }
	}
	useInput((input, key) => {
		if (busy || step === "bedrock") return
		if (key.escape) { onCancel(); return }
		if (step !== "custom" && step !== "budget") return
		if (key.return) {
			if (!selection || !text.trim() || text === CUSTOM_MODEL_ID) return
			if (step === "budget") {
				const budget = Number(text)
				if (!Number.isSafeInteger(budget) || (budget !== 0 && (budget < ANTHROPIC_MIN_THINKING_BUDGET || budget > maxBudget))) { setError(`Use 0 or ${ANTHROPIC_MIN_THINKING_BUDGET}–${maxBudget} tokens`); return }
				setSelection({ ...selection, thinkingBudgetTokens: budget })
			} else setSelection(selectionForModel(selection, text.trim()))
			setError(""); setStep("options")
		} else if (key.backspace || key.delete) setText((current) => current.slice(0, -1))
		else if (input && !key.ctrl && !key.meta) setText((current) => current + input)
	})
	if (step === "bedrock" && selection) return <BedrockCustomFlowPage isActive={!busy} onCancel={() => setStep("model")} onComplete={(arn, baseModelId) => {
		setSelection({ ...selectionForModel(selection, arn, getModelInfoForProvider("bedrock", baseModelId)), awsBedrockCustomSelected: true, awsBedrockCustomModelBaseId: baseModelId }); setStep("options")
	}} />
	return <Box flexDirection="column">
		{error && <Text color={theme.error}>{error}</Text>}
		{busy && <Text>Saving…</Text>}
		{step === "provider" && <SearchableList isActive={!busy} items={choices} onSelect={(item) => {
			const choice = choices.find((candidate) => candidate.id === item.id)!
			setSelection({ provider: choice.provider, modelId: "", openAiProfileName: choice.openAiProfileName }); setStep("model")
		}} />}
		{step === "model" && selection && <ModelPicker provider={selection.provider} controller={controller}
			// Unnamed endpoints use the backend's coherent effective setup, including credential overrides.
			// Named endpoints supply every field explicitly so keyless profiles never inherit legacy auth.
			baseUrl={profile?.baseUrl}
			apiKey={profile ? profile.apiKey ?? "" : undefined}
			headers={profile ? profile.headers ?? EMPTY_HEADERS : undefined}
			isActive={!busy} onChange={() => { }} onSubmit={() => { }} onSelectModel={(id, metadata) => {
				if (id === CUSTOM_MODEL_ID) { setText(""); setStep(selection.provider === "bedrock" ? "bedrock" : "custom"); return }
				setSelection(selectionForModel(selection, id, metadata)); setStep("options")
			}} />}
		{(step === "custom" || step === "budget") && <Text>{step === "budget" ? "Thinking budget (0 = off)" : "Custom model ID"}: {text}▏</Text>}
		{step === "options" && selection && <Box flexDirection="column">
			<Text>{selection.openAiProfileName ?? getProviderLabel(selection.provider)} · {selection.modelId || "Select a model"}</Text>
			<SearchableList isActive={!busy} items={[
				{ id: "provider", label: "Provider / endpoint" }, { id: "model", label: "Model" },
				...efforts.map((effort) => ({ id: `effort:${effort}`, label: `Reasoning: ${effort}${selection.reasoningEffort === effort ? " ✓" : ""}` })),
				...(showBudget ? [{ id: "budget", label: `Thinking budget: ${selection.thinkingBudgetTokens ?? "default"}` }] : []),
				{ id: "save", label: "Save selection" },
			]} onSelect={(item) => {
				if (item.id === "save") { void save(); return }
				if (item.id.startsWith("effort:")) { setSelection({ ...selection, reasoningEffort: item.id.slice(7) as ModelProviderSelection["reasoningEffort"] }); return }
				setText(String(selection.thinkingBudgetTokens ?? 0)); setStep(item.id as "provider" | "model" | "budget")
			}} />
		</Box>}
		<Text color={theme.muted}>Type to search · Enter select · Esc cancel</Text>
	</Box>
}
