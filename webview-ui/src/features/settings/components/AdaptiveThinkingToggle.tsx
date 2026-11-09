import { ANTHROPIC_MIN_THINKING_BUDGET } from "@shared/api"
import type { Mode } from "@shared/ExtensionMessage"
import { VSCodeCheckbox } from "@vscode/webview-ui-toolkit/react"
import { useSettingsStore } from "@/features/settings/store/settingsStore"
import { getModeSpecificFields } from "./utils/providerUtils"
import { useApiConfigurationHandlers } from "./utils/useApiConfigurationHandlers"

interface AdaptiveThinkingInputProps {
	budgetTokens?: number
	effort?: string
	supportsBetweenToolsThinking?: boolean
	onChange: (budgetTokens: number) => void
}

/** Reuse the saved budget's zero/nonzero toggle without advertising unsupported manual budgets. */
export function AdaptiveThinkingInput({ budgetTokens, effort, supportsBetweenToolsThinking, onChange }: AdaptiveThinkingInputProps) {
	const requiresThinking = effort === "xhigh" || effort === "max"
	return (
		<VSCodeCheckbox
			checked={requiresThinking || budgetTokens !== 0}
			disabled={requiresThinking}
			onChange={(event: any) => onChange(event.target.checked ? ANTHROPIC_MIN_THINKING_BUDGET : 0)}>
			{supportsBetweenToolsThinking ? "Enable up-front thinking" : "Enable thinking"}
			{requiresThinking ? " (required at this effort)" : ""}
		</VSCodeCheckbox>
	)
}

export default function AdaptiveThinkingToggle({ currentMode, supportsBetweenToolsThinking }: { currentMode: Mode; supportsBetweenToolsThinking?: boolean }) {
	const { apiConfiguration } = useSettingsStore()
	const { handleModeFieldChange } = useApiConfigurationHandlers()
	const fields = getModeSpecificFields(apiConfiguration, currentMode)
	return (
		<AdaptiveThinkingInput
			budgetTokens={fields.thinkingBudgetTokens}
			effort={fields.reasoningEffort}
			supportsBetweenToolsThinking={supportsBetweenToolsThinking}
			onChange={(value) => { void handleModeFieldChange({ plan: "planModeThinkingBudgetTokens", act: "actModeThinkingBudgetTokens" }, value, currentMode) }}
		/>
	)
}
