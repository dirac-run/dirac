import {
	DEFAULT_OPENAI_REASONING_EFFORT,
	isOpenaiReasoningEffort,
	Mode,
	OPENAI_REASONING_EFFORT_LABELS,
	OPENAI_REASONING_EFFORT_OPTIONS,
	OpenaiReasoningEffort,
} from "@shared/ExtensionMessage"
import { memo } from "react"
import { useSettingsStore } from "@/features/settings/store/settingsStore"
import { Label } from "@/shared/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/shared/ui/select"
import { getModeSpecificFields } from "./utils/providerUtils"
import { useApiConfigurationHandlers } from "./utils/useApiConfigurationHandlers"

interface ReasoningEffortSelectorProps {
	currentMode: Mode
	label?: string
	description?: string
	allowedEfforts?: readonly OpenaiReasoningEffort[]
	defaultEffort?: OpenaiReasoningEffort
	compact?: boolean
}

export const ReasoningEffortInput = ({
	value,
	onChange,
	compact = false,
	label = "Reasoning Effort",
	description = "Higher effort improves depth, but uses more tokens.",
	allowedEfforts = OPENAI_REASONING_EFFORT_OPTIONS,
	defaultEffort = DEFAULT_OPENAI_REASONING_EFFORT,
}: Omit<ReasoningEffortSelectorProps, "currentMode"> & {
	value?: OpenaiReasoningEffort
	onChange: (value: OpenaiReasoningEffort) => void
}) => {
	const selectedEffort =
		isOpenaiReasoningEffort(value) && allowedEfforts.includes(value)
			? value
			: allowedEfforts.includes(defaultEffort)
				? defaultEffort
				: allowedEfforts[0]

	if (compact)
		return (
			<Select
				value={selectedEffort}
				onValueChange={(effort) => {
					if (isOpenaiReasoningEffort(effort)) onChange(effort)
				}}>
				<SelectTrigger
					size="sm"
					aria-label={label}
					title={`${label}: ${description}`}
					className="h-7 rounded-sm px-2 text-xs">
					<span className="text-description">Reasoning</span>
					<SelectValue />
				</SelectTrigger>
				<SelectContent align="start">
					{allowedEfforts.map((effort) => (
						<SelectItem key={effort} value={effort}>
							{OPENAI_REASONING_EFFORT_LABELS[effort]}
						</SelectItem>
					))}
					<p className="max-w-56 px-2 py-1 text-xs text-description">{description}</p>
				</SelectContent>
			</Select>
		)

	return (
		<div style={{ marginTop: 10, marginBottom: 5 }}>
			<Label className="text-xs font-medium">{label}</Label>
			<Select
				onValueChange={(value) => {
					if (isOpenaiReasoningEffort(value)) onChange(value)
				}}
				value={selectedEffort}>
				<SelectTrigger className="w-full mt-1">
					<SelectValue />
				</SelectTrigger>
				<SelectContent>
					{allowedEfforts.map((effort) => (
						<SelectItem key={effort} value={effort}>
							{OPENAI_REASONING_EFFORT_LABELS[effort]}
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

const ReasoningEffortSelector = ({ currentMode, ...props }: ReasoningEffortSelectorProps) => {
	const { apiConfiguration } = useSettingsStore()
	const { handleModeFieldChange } = useApiConfigurationHandlers()
	const value = getModeSpecificFields(apiConfiguration, currentMode).reasoningEffort
	return (
		<ReasoningEffortInput
			{...props}
			value={isOpenaiReasoningEffort(value) ? value : undefined}
			onChange={(effort) => {
				void handleModeFieldChange(
					{ plan: "planModeReasoningEffort", act: "actModeReasoningEffort" },
					effort,
					currentMode,
				)
			}}
		/>
	)
}

export default memo(ReasoningEffortSelector)
