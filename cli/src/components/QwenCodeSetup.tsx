import * as fs from "node:fs"
import React, { useState } from "react"
import { Box, Text, useInput } from "ink"
import type { Controller } from "@/core/controller"
import { StateManager } from "@/core/storage/StateManager"
import { getQwenCachedCredentialPath } from "@/utils/qwenCodeCredentialPath"
import { theme } from "../constants/theme"
import { shouldIgnoreTerminalInput } from "../utils/input"
import { saveProviderSetup } from "../utils/provider-config"

/** Configure the official CLI's subscription cache without collecting an API key. */
export const QwenCodeSetup: React.FC<{
	controller?: Controller
	onComplete: () => void | Promise<void>
	onCancel: () => void
}> = ({ controller, onComplete, onCancel }) => {
	const [credentialPath, setCredentialPath] = useState(() => StateManager.get().getApiConfiguration().qwenCodeOauthPath ?? "")
	const [error, setError] = useState("")
	const [busy, setBusy] = useState(false)
	const save = async () => {
		setBusy(true)
		setError("")
		try {
			const customPath = credentialPath.trim()
			const resolvedPath = getQwenCachedCredentialPath(customPath)
			if (!fs.existsSync(resolvedPath)) throw new Error(`Credentials not found at ${resolvedPath}. Sign in with /auth in the official Qwen Code CLI first.`)
			await saveProviderSetup({ providerId: "qwen-code", qwenCodeOauthPath: customPath, controller })
			await onComplete()
		} catch (failure) {
			setError(failure instanceof Error ? failure.message : String(failure))
		} finally {
			setBusy(false)
		}
	}
	useInput((input, key) => {
		if (busy || shouldIgnoreTerminalInput(input, key)) return
		if (key.escape) { onCancel(); return }
		if (key.return) { void save(); return }
		if (key.backspace || key.delete) setCredentialPath((value) => value.slice(0, -1))
		else if (input && !key.ctrl && !key.meta) setCredentialPath((value) => value + input)
	})
	return <Box flexDirection="column">
		<Text bold>Qwen Code Plus / Pro subscription</Text>
		<Text>Launch the official Qwen Code CLI (qwen), run /auth, and choose subscription sign-in.</Text>
		<Text>After sign-in, Dirac uses subscription_credentials.json, not a DashScope API key.</Text>
		<Text>Optional custom file path (~/ supported): {credentialPath}</Text>
		<Text dimColor>Blank: QWEN_HOME/subscription_credentials.json, or ~/.qwen/subscription_credentials.json.</Text>
		<Text dimColor>Resolved path: {getQwenCachedCredentialPath(credentialPath.trim())}</Text>
		<Text dimColor>Setup checks file presence only; it does not verify account access.</Text>
		{error && <Text color={theme.error}>{error}</Text>}
		<Text>{busy ? "Saving…" : "Enter save · Esc cancel"}</Text>
	</Box>
}
