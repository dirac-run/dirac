import { unbiasedModels } from "@shared/api"
import { Mode } from "@shared/ExtensionMessage"
import { EmptyRequest, StringRequest } from "@shared/proto/dirac/common"
import { UnbiasedAuthEvent } from "@shared/proto/dirac/models"
import { useEffect, useRef, useState } from "react"
import { FileServiceClient, ModelsServiceClient, UiServiceClient } from "@/shared/api/grpc-client"
import { Button } from "@/shared/ui/button"
import { normalizeApiConfiguration } from "@/features/settings/components/utils/providerUtils"
import { useSettingsStore } from "@/features/settings/store/settingsStore"
import { ApiKeyField } from "../common/ApiKeyField"
import { ModelInfoView } from "../common/ModelInfoView"
import { ModelSelector } from "../common/ModelSelector"
import { useApiConfigurationHandlers } from "../utils/useApiConfigurationHandlers"

interface UnbiasedProviderProps {
	showModelOptions: boolean
	isPopup?: boolean
	currentMode: Mode
}

export function UnbiasedProvider({ showModelOptions, isPopup, currentMode }: UnbiasedProviderProps) {
	const { apiConfiguration, unbiasedWorkloadName, pendingApiConfigurationUpdates } = useSettingsStore()
	const isAuthenticated = !!apiConfiguration?.unbiasedApiKey
	const workloadName = Object.hasOwn(pendingApiConfigurationUpdates, "unbiasedApiKey") ? undefined : unbiasedWorkloadName
	const { handleFieldChange, handleModeFieldChange } = useApiConfigurationHandlers()
	const { selectedModelId, selectedModelInfo } = normalizeApiConfiguration(apiConfiguration, currentMode)
	const [instructions, setInstructions] = useState<UnbiasedAuthEvent>()
	const [isSigningIn, setIsSigningIn] = useState(false)
	const [isSigningOut, setIsSigningOut] = useState(false)
	const [error, setError] = useState<string>()
	const [notice, setNotice] = useState<string>()
	const cancelRef = useRef<() => void>()
	const attempt = useRef(0)
	const cancel = () => {
		attempt.current++
		cancelRef.current?.()
		cancelRef.current = undefined
		setIsSigningIn(false)
		setInstructions(undefined)
	}
	useEffect(
		() => () => {
			attempt.current++
			cancelRef.current?.()
		},
		[],
	)

	const signIn = () => {
		cancel()
		setError(undefined)
		setNotice(undefined)
		setIsSigningIn(true)
		const generation = attempt.current
		cancelRef.current = ModelsServiceClient.authenticateUnbiased(EmptyRequest.create({}), {
			onResponse: (event) => {
				if (generation !== attempt.current) return
				if (event.completed) {
					setNotice(`Signed in to ${event.workloadName || "Unbiased"}.`)
					setIsSigningIn(false)
					setInstructions(undefined)
				} else setInstructions(event)
			},
			onError: (failure) => {
				if (generation !== attempt.current) return
				setError(failure.message)
				cancel()
			},
			onComplete: () => {
				if (generation !== attempt.current) return
				cancelRef.current = undefined
				setIsSigningIn(false)
				setInstructions(undefined)
			},
		})
	}

	const signOut = async () => {
		setIsSigningOut(true)
		setError(undefined)
		setNotice(undefined)
		try {
			await ModelsServiceClient.signOutUnbiased(EmptyRequest.create({}))
			setNotice("Signed out locally. Revoke the key in the Unbiased dashboard to disable it.")
		} catch (failure) {
			setError(failure instanceof Error ? failure.message : "Unbiased sign-out failed")
		} finally {
			setIsSigningOut(false)
		}
	}

	const copy = async (value: string) => {
		try {
			await FileServiceClient.copyToClipboard(StringRequest.create({ value }))
			setNotice("Copied to clipboard.")
		} catch {
			setNotice("Could not copy. Select the text above instead.")
		}
	}

	return (
		<div className="space-y-3">
			<div className="space-y-2">
				{isAuthenticated ? (
					<section aria-label="Unbiased account" className="rounded-md border border-(--vscode-panel-border) p-3">
						<div className="flex min-w-0 items-center justify-between gap-3">
							<div className="min-w-0">
								<p className="m-0 text-sm font-medium">Connected to Unbiased</p>
								<p className="mb-0 mt-1 break-all text-xs">Signed in to {workloadName || "Unbiased"}</p>
							</div>
							<Button
								disabled={isSigningIn || isSigningOut}
								onClick={() => void signOut()}
								size="sm"
								type="button"
								variant="outline">
								{isSigningOut ? "Signing out…" : "Sign out on this device"}
							</Button>
						</div>
					</section>
				) : (
					<Button disabled={isSigningIn || isSigningOut} onClick={signIn} size="sm" type="button">
						Sign in with Unbiased
					</Button>
				)}
				{isSigningIn && <p className="text-xs">{instructions ? "Waiting for approval…" : "Preparing sign-in…"}</p>}
				{instructions && (
					<div className="space-y-2 text-xs">
						<p>Open this page and enter the code (works on remote machines):</p>
						<input aria-label="Unbiased verification URL" className="w-full" readOnly value={instructions.url} />
						<code className="select-all text-base">{instructions.userCode}</code>
						<div className="flex gap-2">
							<Button onClick={() => void copy(instructions.userCode)} size="sm" type="button" variant="outline">
								Copy code
							</Button>
							<Button onClick={() => void copy(instructions.url)} size="sm" type="button" variant="outline">
								Copy URL
							</Button>
							<Button
								onClick={() =>
									void UiServiceClient.openUrl(
										StringRequest.create({ value: instructions.verificationUriComplete }),
									).catch(() => setNotice("Could not open browser; use the URL above."))
								}
								size="sm"
								type="button">
								Open browser
							</Button>
						</div>
					</div>
				)}
				{isSigningIn && (
					<Button onClick={cancel} size="sm" type="button" variant="ghost">
						Cancel
					</Button>
				)}
				{notice && (
					<p role="status" className="text-xs">
						{notice}
					</p>
				)}
				{error && (
					<p role="alert" className="text-xs">
						{error}
					</p>
				)}
			</div>
			<ApiKeyField
				helpText="Alternatively, enter an Unbiased API key. Keys are stored locally; remove the key here to sign out locally. Revoke it in the Unbiased dashboard to disable it."
				initialValue={apiConfiguration?.unbiasedApiKey || ""}
				onChange={(value: string) => handleFieldChange("unbiasedApiKey", value)}
				providerName="Unbiased"
				signupUrl="https://platform.unbiased.ai"
			/>
			{showModelOptions && (
				<>
					<ModelSelector
						label="Model"
						models={unbiasedModels}
						onChange={(event: any) =>
							handleModeFieldChange(
								{ plan: "planModeApiModelId", act: "actModeApiModelId" },
								event.target.value,
								currentMode,
							)
						}
						selectedModelId={selectedModelId}
					/>
					<ModelInfoView isPopup={isPopup} modelInfo={selectedModelInfo} selectedModelId={selectedModelId} />
					<p className="text-xs">Prices shown are pay-as-you-go estimates; subscriptions use plan quotas.</p>
				</>
			)}
		</div>
	)
}
