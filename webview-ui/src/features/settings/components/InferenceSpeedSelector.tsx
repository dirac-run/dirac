import {
	DEFAULT_INFERENCE_SPEED,
	INFERENCE_SPEED_LABELS,
	INFERENCE_SPEED_OPTIONS,
	isInferenceSpeed,
	type InferenceSpeed,
	type Mode,
} from "@shared/ExtensionMessage"
import { memo, useEffect } from "react"
import { useSettingsStore } from "@/features/settings/store/settingsStore"
import { Label } from "@/shared/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/shared/ui/select"
import { getModeSpecificFields } from "./utils/providerUtils"
import { useApiConfigurationHandlers } from "./utils/useApiConfigurationHandlers"

interface InferenceSpeedSelectorProps {
	currentMode: Mode
	description: string
	supportsFastMode: boolean
	allowedSpeeds?: readonly InferenceSpeed[]
	compact?: boolean
	label?: string
}

const InferenceSpeedSelector = ({
	currentMode,
	description,
	compact = false,
	label = "Inference Speed",
	supportsFastMode,
	allowedSpeeds = INFERENCE_SPEED_OPTIONS,
}: InferenceSpeedSelectorProps) => {
	const { apiConfiguration } = useSettingsStore()
	const { handleModeFieldChange } = useApiConfigurationHandlers()
	const configuredSpeed = getModeSpecificFields(apiConfiguration, currentMode).inferenceSpeed
	useEffect(() => {
		if (supportsFastMode || configuredSpeed !== "fast") return
		void handleModeFieldChange(
			{ plan: "planModeInferenceSpeed", act: "actModeInferenceSpeed" },
			DEFAULT_INFERENCE_SPEED,
			currentMode,
		)
	}, [configuredSpeed, currentMode, handleModeFieldChange, supportsFastMode])

	const selectableSpeeds = supportsFastMode ? allowedSpeeds : allowedSpeeds.filter((speed) => speed !== "fast")
	const selectedSpeed =
		isInferenceSpeed(configuredSpeed) && selectableSpeeds.includes(configuredSpeed)
			? configuredSpeed
			: DEFAULT_INFERENCE_SPEED

	if (compact)
		return (
			<Select
				value={selectedSpeed}
				onValueChange={(value) => {
					void handleModeFieldChange(
						{ plan: "planModeInferenceSpeed", act: "actModeInferenceSpeed" },
						value as InferenceSpeed,
						currentMode,
					)
				}}>
				<SelectTrigger
					size="sm"
					aria-label={label}
					title={`${label}: ${description}`}
					className="h-7 rounded-sm px-2 text-xs">
					<span className="text-description">Speed</span>
					<SelectValue />
				</SelectTrigger>
				<SelectContent align="start">
					{selectableSpeeds.map((speed) => (
						<SelectItem key={speed} value={speed}>
							{INFERENCE_SPEED_LABELS[speed]}
						</SelectItem>
					))}
					<p className="max-w-56 px-2 py-1 text-xs text-description">{description}</p>
				</SelectContent>
			</Select>
		)

	return (
		<div style={{ marginTop: 10, marginBottom: 5 }}>
			<Label className="text-xs font-medium">Inference Speed</Label>
			<Select
				onValueChange={(value) =>
					handleModeFieldChange(
						{ plan: "planModeInferenceSpeed", act: "actModeInferenceSpeed" },
						value as InferenceSpeed,
						currentMode,
					)
				}
				value={selectedSpeed}>
				<SelectTrigger className="w-full mt-1">
					<SelectValue />
				</SelectTrigger>
				<SelectContent>
					{selectableSpeeds.map((speed) => (
						<SelectItem key={speed} value={speed}>
							{INFERENCE_SPEED_LABELS[speed]}
						</SelectItem>
					))}
				</SelectContent>
			</Select>
			<p
				style={{
					fontSize: "12px",
					marginTop: 3,
					marginBottom: 0,
					color: "var(--vscode-descriptionForeground)",
				}}>
				{description}
			</p>
		</div>
	)
}

export default memo(InferenceSpeedSelector)
