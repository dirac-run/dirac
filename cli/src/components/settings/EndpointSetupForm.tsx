import React, { useState } from "react"
import { Box, Text, useInput } from "ink"
import type { OpenAiCompatibleProfile } from "@shared/api"
import type { Controller } from "@/core/controller"
import { StateManager } from "@/core/storage/StateManager"
import { applyProviderSetupTransaction } from "@/core/controller/models/apiConfigurationTransaction"
import { theme } from "../../constants/theme"

/** Edit endpoint setup only, preserving legacy model metadata and unrelated profiles. */
export const EndpointSetupForm: React.FC<{ profile?: OpenAiCompatibleProfile; controller?: Controller; onDone: () => void; onCancel: () => void }> = ({ profile, controller, onDone, onCancel }) => {
	const [values, setValues] = useState([profile?.name ?? "", profile?.baseUrl ?? "", profile?.apiKey ?? "", JSON.stringify(profile?.headers ?? {}), profile?.azureApiVersion ?? ""])
	const [field, setField] = useState(profile ? 1 : 0)
	const [error, setError] = useState("")
	const [busy, setBusy] = useState(false)
	const labels = ["Endpoint name", "Base URL", "API key (optional)", "Headers (JSON)", "Azure API version (optional)"]
	const save = async () => {
		const state = StateManager.get()
		setBusy(true); setError("")
		try {
			const [name, baseUrl, apiKey, headersText, azureApiVersion] = values
			if (!name.trim() || !baseUrl.trim()) throw new Error("Endpoint name and URL are required")
			new URL(baseUrl)
			const previous = structuredClone(state.getSystemDefaultSettingsKey("openAiCompatibleProfiles"))
			if (previous.some((item) => item.name === name.trim() && item.name !== profile?.name)) throw new Error("Endpoint names must be unique")
			const headers = JSON.parse(headersText)
			if (!headers || Array.isArray(headers) || typeof headers !== "object" || Object.values(headers).some((value) => typeof value !== "string")) throw new Error("Headers must be a string map")
			const endpoint: OpenAiCompatibleProfile = { modelId: "", modelInfo: { supportsPromptCache: false }, ...profile, name: name.trim(), baseUrl: baseUrl.trim(), apiKey, headers, azureApiVersion }
			const patch = { openAiCompatibleProfiles: [...previous.filter((item) => item.name !== profile?.name), endpoint] }
			await applyProviderSetupTransaction(controller ?? { stateManager: state }, patch, async () => {
				try { state.setApiConfiguration(patch); await state.flushPendingState() }
				catch (failure) { state.setApiConfiguration({ openAiCompatibleProfiles: previous }); await state.flushPendingState(); throw failure }
			})
			await controller?.postStateToWebview(); onDone()
		} catch (failure) { setError(failure instanceof Error ? failure.message : String(failure)) }
		finally { setBusy(false) }
	}
	useInput((input, key) => {
		if (busy) return
		if (key.escape) { onCancel(); return }
		if (key.tab || key.downArrow) { setField((current) => Math.min(labels.length - 1, current + 1)); return }
		if (key.upArrow) { setField((current) => Math.max(profile ? 1 : 0, current - 1)); return }
		if (key.return) { if (field < labels.length - 1) setField(field + 1); else void save(); return }
		if (key.backspace || key.delete) setValues((current) => current.map((value, index) => index === field ? value.slice(0, -1) : value))
		else if (input && !key.ctrl && !key.meta) setValues((current) => current.map((value, index) => index === field ? value + input : value))
	})
	return <Box flexDirection="column">
		{labels.map((label, index) => <Text key={label}>{index === field ? "› " : "  "}{label}: {index === 2 ? "•".repeat(values[index].length) : values[index]}</Text>)}
		{error && <Text color={theme.error}>{error}</Text>}
		<Text color={theme.muted}>{busy ? "Saving…" : "Tab next · Enter next/save · Esc cancel"}</Text>
	</Box>
}
