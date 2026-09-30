import { useSettingsStore } from "@/features/settings/store/settingsStore"
import { Switch } from "@/shared/ui/switch"
import Section from "../Section"
import { updateSetting } from "../utils/settingsHandlers"

interface RunningTasksSectionProps {
	renderSectionHeader: (tabId: string) => JSX.Element | null
}

type TaskSettingKey =
	| "subagentsEnabled"
	| "enableParallelToolCalling"
	| "doubleCheckCompletionEnabled"
	| "backgroundEditEnabled"
	| "enableCheckpointsSetting"
	| "worktreesEnabled"

interface TaskSetting {
	id: string
	label: string
	description: string
	settingKey: TaskSettingKey
	checked: boolean
	visible?: boolean
}

const RunningTasksSection = ({ renderSectionHeader }: RunningTasksSectionProps) => {
	const {
		backgroundEditEnabled,
		doubleCheckCompletionEnabled,
		enableCheckpointsSetting,
		enableParallelToolCalling,
		subagentsEnabled,
		worktreesEnabled,
	} = useSettingsStore()
	const settings: TaskSetting[] = [
		{
			id: "subagents",
			label: "Subagents",
			description:
				"Run focused subagents in parallel to research, edit files, run commands, and verify work. This may increase token usage.",
			settingKey: "subagentsEnabled",
			checked: subagentsEnabled,
		},
		{
			id: "parallel-tool-calling",
			label: "Parallel tool calling",
			description:
				"Run independent tool calls concurrently. Execution order is not guaranteed and resource use may increase.",
			settingKey: "enableParallelToolCalling",
			checked: enableParallelToolCalling,
		},
		{
			id: "double-check-completion",
			label: "Double-check completion",
			description:
				"Require an additional verification pass before accepting completion. This adds latency and may use more tokens.",
			settingKey: "doubleCheckCompletionEnabled",
			checked: doubleCheckCompletionEnabled,
		},
		{
			id: "background-edit",
			label: "Background edits",
			description: "Apply edits without taking focus from the active editor.",
			settingKey: "backgroundEditEnabled",
			checked: backgroundEditEnabled,
		},
		{
			id: "checkpoints",
			label: "Checkpoints",
			description: "Save recoverable task states that can be restored later.",
			settingKey: "enableCheckpointsSetting",
			checked: enableCheckpointsSetting,
		},
		{
			id: "worktrees",
			label: "Worktrees",
			description: "Use Git worktrees to isolate parallel tasks. This creates additional working directories and branches.",
			settingKey: "worktreesEnabled",
			checked: worktreesEnabled.user,
			visible: worktreesEnabled.featureFlag,
		},
	]

	return (
		<div className="mb-2">
			{renderSectionHeader("running-tasks")}
			<Section>
				<div className="rounded border border-(--vscode-widget-border) p-3">
					{settings
						.filter((setting) => setting.visible ?? true)
						.map((setting) => (
							<div
								className="border-b border-(--vscode-panel-border) py-3 last:border-b-0"
								id={setting.id}
								key={setting.id}>
								<div className="flex items-center justify-between gap-4">
									<span className="text-sm font-medium">{setting.label}</span>
									<Switch
										aria-label={setting.label}
										checked={setting.checked}
										onCheckedChange={(checked) => updateSetting(setting.settingKey, checked)}
										size="lg"
									/>
								</div>
								<p className="mb-0 mt-1 text-xs text-description">{setting.description}</p>
							</div>
						))}
				</div>
			</Section>
		</div>
	)
}

export default RunningTasksSection
