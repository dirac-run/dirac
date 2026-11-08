import React, { useState } from "react"
import { Box, Text, useInput } from "ink"
import type { ApiProvider } from "@shared/api"
import { ProviderToApiKeyMap, ProviderToBaseUrlKeyMap } from "@shared/storage/provider-keys"
import type { SecretKey } from "@shared/storage/state-keys"
import { StateManager } from "@/core/storage/StateManager"
import type { Controller } from "@/core/controller"
import { saveProviderSetup } from "../../utils/provider-config"
import { theme } from "../../constants/theme"

export const ProviderAccessForm: React.FC<{ provider: ApiProvider; controller?: Controller; onDone: () => void; onCancel: () => void }> = ({ provider, controller, onDone, onCancel }) => {
	const state = StateManager.get()
	const keyField = ProviderToApiKeyMap[provider]
	const secret = Array.isArray(keyField) ? keyField[0] : keyField
	const urlField = ProviderToBaseUrlKeyMap[provider]
	const fields = [...(secret ? ["API key"] : []), ...(urlField ? ["Base URL"] : []), ...(provider === "openai" ? ["Headers (JSON; {} to clear)"] : [])]
	const [values, setValues] = useState([...(secret ? [state.getSecretKey(secret as SecretKey) ?? ""] : []), ...(urlField ? [String(state.getSystemDefaultSettingsKey(urlField) ?? "")] : []), ...(provider === "openai" ? [JSON.stringify(state.getSystemDefaultSettingsKey("openAiHeaders") ?? {})] : [])])
	const [index, setIndex] = useState(0)
	const [error, setError] = useState("")
	const [busy, setBusy] = useState(false)
	const save = async () => {
		setBusy(true)
		try {
			const headers = provider === "openai" ? JSON.parse(values[2]) : undefined
			if (provider === "openai" && (!headers || Array.isArray(headers) || typeof headers !== "object" || Object.values(headers).some((value) => typeof value !== "string"))) {
				throw new Error("Headers must be a string map")
			}
			await saveProviderSetup({ providerId: provider, apiKey: secret ? values[0] : undefined, baseUrl: urlField ? values[secret ? 1 : 0] : undefined, headers, controller })
			onDone()
		} catch (failure) { setError(failure instanceof Error ? failure.message : String(failure)) }
		finally { setBusy(false) }
	}
	useInput((input, key) => {
		if (busy) return
		if (key.escape) { onCancel(); return }
		if (key.tab || key.downArrow) { setIndex((current) => Math.min(fields.length - 1, current + 1)); return }
		if (key.upArrow) { setIndex((current) => Math.max(0, current - 1)); return }
		if (key.return) { if (index < fields.length - 1) setIndex(index + 1); else void save(); return }
		if (key.backspace || key.delete) setValues((current) => current.map((value, i) => i === index ? value.slice(0, -1) : value))
		else if (input && !key.ctrl && !key.meta) setValues((current) => current.map((value, i) => i === index ? value + input : value))
	})
	return <Box flexDirection="column">
		{fields.map((label, i) => <Text key={label}>{i === index ? "› " : "  "}{label}: {label === "API key" ? "•".repeat(values[i].length) : values[i]}</Text>)}
		{error && <Text color={theme.error}>{error}</Text>}
		<Text>Enter next/save · Tab navigate · Esc cancel</Text>
	</Box>
}
