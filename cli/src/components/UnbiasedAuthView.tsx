import os from "node:os"
import { Box, Text, useInput } from "ink"
import Spinner from "ink-spinner"
import React, { useEffect, useRef, useState } from "react"
import { startUnbiasedDeviceAuth, pollUnbiasedDeviceAuth, type UnbiasedDeviceGrant } from "@/integrations/unbiased/device-auth"
import { createUnbiasedOAuthAccount } from "@/integrations/unbiased/oauth-account"
import { fetch } from "@/shared/net"
import { openExternal } from "@/utils/env"
import { theme } from "../constants/theme"
import { useStdinContext } from "../context/StdinContext"
import { applyProviderConfig } from "../utils/provider-config"
import { copyToClipboardNative } from "../utils/clipboard"
import type { Controller } from "@/core/controller"
import { StateManager } from "@/core/storage/StateManager"

interface UnbiasedAuthViewProps {
	controller?: Controller
	onComplete: () => void | Promise<void>
	onCancel: () => void
}

export const UnbiasedAuthView: React.FC<UnbiasedAuthViewProps> = ({ controller, onComplete, onCancel }) => {
	const { isRawModeSupported } = useStdinContext()
	const [grant, setGrant] = useState<UnbiasedDeviceGrant>()
	const [error, setError] = useState<string>()
	const [notice, setNotice] = useState<string>()
	const [attempt, setAttempt] = useState(0)
	const abortRef = useRef<AbortController | null>(null)
	const committingRef = useRef(false)
	const [isCommitting, setIsCommitting] = useState(false)
	const completeRef = useRef(onComplete)
	completeRef.current = onComplete

	useEffect(() => {
		const abort = new AbortController()
		abortRef.current = abort
		committingRef.current = false
		setIsCommitting(false)
		setGrant(undefined)
		setError(undefined)
		setNotice(undefined)
		void (async () => {
			try {
				const options = { fetcher: fetch, signal: abort.signal }
				const instructions = await startUnbiasedDeviceAuth(os.hostname(), options)
				if (abort.signal.aborted) return
				setGrant(instructions)
				const token = await pollUnbiasedDeviceAuth(instructions, options)
				// A 200 is one-shot. Save the key before any provider switch can fail.
				const stateManager = StateManager.get()
				committingRef.current = !abort.signal.aborted
				setIsCommitting(committingRef.current)
				stateManager.setSecret("unbiasedApiKey", token.accessToken)
				stateManager.setGlobalStateBatch(createUnbiasedOAuthAccount(token))
				await stateManager.flushPendingState()
				// A cancelled sign-in may still issue a key; save it, but do not switch providers.
				if (abort.signal.aborted) return
				await applyProviderConfig({ providerId: "unbiased", apiKey: token.accessToken, modelId: "pareto", controller })
				await completeRef.current()
			} catch (failure) {
				if (!abort.signal.aborted || committingRef.current) {
					setError(failure instanceof Error ? failure.message : "Unbiased sign-in failed")
				}
			} finally {
				committingRef.current = false
				setIsCommitting(false)
			}
		})()
		return () => abort.abort()
	}, [attempt, controller])

	useInput(
		(input, key) => {
			if (key.escape) {
				if (committingRef.current) return
				abortRef.current?.abort()
				onCancel()
				return
			}
			if (error && input === "r") {
				setAttempt((value) => value + 1)
				return
			}
			if (!grant) return
			if (input === "c" || input === "l") {
				setNotice(
					copyToClipboardNative(input === "c" ? grant.userCode : grant.verificationUri)
						? "Copied."
						: "Could not copy; select the text above.",
				)
			}
			if (input === "o") {
				void openExternal(grant.verificationUriComplete).catch(() =>
					setNotice("Could not open browser; use the URL and code above."),
				)
			}
		},
		{ isActive: isRawModeSupported },
	)

	return (
		<Box flexDirection="column" padding={1}>
			<Text bold color={theme.text}>
				Sign in with Unbiased
			</Text>
			{error ? (
				<React.Fragment>
					<Text color={theme.error}>{error}</Text>
					<Text color={theme.muted}>r retry · Esc back</Text>
				</React.Fragment>
			) : (
				<React.Fragment>
					<Text color={theme.text}>
						<Spinner type="dots" />{" "}
						{isCommitting ? "Saving Unbiased configuration…" : grant ? "Waiting for Unbiased approval…" : "Preparing sign-in…"}
					</Text>
					{grant && (
						<React.Fragment>
							<Text>Open this URL in any browser and enter the code:</Text>
							<Text color={theme.info} wrap="wrap">
								{grant.verificationUri}
							</Text>
							<Text bold color={theme.warning}>
								{grant.userCode}
							</Text>
							<Text color={theme.muted}>
								{isCommitting ? "Saving configuration; please wait" : "c copy code · l copy URL · o open browser · Esc cancel"}
							</Text>
						</React.Fragment>
					)}
					{notice && <Text color={theme.warning}>{notice}</Text>}
				</React.Fragment>
			)}
		</Box>
	)
}
