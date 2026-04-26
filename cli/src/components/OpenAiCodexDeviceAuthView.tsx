import { Box, Text, useInput } from "ink"
import Spinner from "ink-spinner"
import React, { useCallback, useEffect, useRef, useState } from "react"
import { openAiCodexOAuthManager } from "@/integrations/openai-codex/oauth"
import { openExternal } from "@/utils/env"
import { COLORS } from "../constants/colors"
import { useStdinContext } from "../context/StdinContext"

interface OpenAiCodexDeviceAuthViewProps {
	onComplete: () => void | Promise<void>
	onCancel: () => void
}

export const OpenAiCodexDeviceAuthView: React.FC<OpenAiCodexDeviceAuthViewProps> = ({ onComplete, onCancel }) => {
	const { isRawModeSupported } = useStdinContext()
	const abortControllerRef = useRef<AbortController | null>(null)
	const isActiveRef = useRef(true)
	const [step, setStep] = useState<"initiating" | "waiting" | "success" | "error">("initiating")
	const [authData, setAuthData] = useState<{
		verification_uri: string
		verification_uri_complete?: string
		user_code: string
		device_code: string
		interval?: number
	} | null>(null)
	const [errorMessage, setErrorMessage] = useState("")

	const startAuth = useCallback(async () => {
		const abortController = new AbortController()
		abortControllerRef.current = abortController

		try {
			setStep("initiating")
			const data = await openAiCodexOAuthManager.initiateDeviceFlow()
			if (!isActiveRef.current) return
			setAuthData(data)
			setStep("waiting")

			await openExternal(data.verification_uri)

			await openAiCodexOAuthManager.pollForDeviceToken(data.device_code, data.user_code, data.interval ?? 5, abortController.signal)
			if (!isActiveRef.current) return
			setStep("success")
			setTimeout(() => {
				if (!isActiveRef.current) return
				void onComplete()
			}, 1500)
		} catch (error) {
			if (!isActiveRef.current) return
			setErrorMessage(error instanceof Error ? error.message : String(error))
			setStep("error")
		}
	}, [onComplete])

	useEffect(() => {
		isActiveRef.current = true
		startAuth()

		return () => {
			isActiveRef.current = false
			abortControllerRef.current?.abort()
		}
	}, [startAuth])

	useInput(
		(_, key) => {
			if (key.escape) {
				isActiveRef.current = false
				abortControllerRef.current?.abort()
				onCancel()
			}
		},
		{ isActive: isRawModeSupported },
	)

	return (
		<Box flexDirection="column" padding={1}>
			{step === "initiating" && (
				<Box>
					<Text color={COLORS.primaryBlue}>
						<Spinner type="dots" />
					</Text>
					<Text color="white"> Initiating ChatGPT device authentication...</Text>
				</Box>
			)}

			{step === "waiting" && authData && (
				<Box flexDirection="column">
					<Box>
						<Text color={COLORS.primaryBlue}>
							<Spinner type="dots" />
						</Text>
						<Text color="white"> Waiting for ChatGPT authorization...</Text>
					</Box>
					<Text> </Text>
					<Text color="white">1. Open: </Text>
					<Text color="cyan" bold underline wrap="wrap">
						{authData.verification_uri_complete || authData.verification_uri}
					</Text>
					<Text> </Text>
					<Text color="white">2. Enter code: </Text>
					<Text color="yellow" bold>
						{authData.user_code}
					</Text>
					<Text> </Text>
					<Text color="gray">The browser should have opened automatically if available.</Text>
					<Text color="gray">Press Esc to cancel.</Text>
				</Box>
			)}

			{step === "success" && (
				<Box>
					<Text color="green">✔</Text>
					<Text color="white"> Successfully authenticated with ChatGPT!</Text>
				</Box>
			)}

			{step === "error" && (
				<Box flexDirection="column">
					<Text color="red" bold>
						Authentication Error
					</Text>
					<Text color="white">{errorMessage}</Text>
					<Text> </Text>
					<Text color="gray">Press Esc to go back.</Text>
				</Box>
			)}
		</Box>
	)
}
