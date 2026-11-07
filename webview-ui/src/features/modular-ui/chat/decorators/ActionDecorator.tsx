import type { ModelProviderPreset } from "@shared/api"
import type { TaskStatus } from "@shared/ExtensionMessage"
import { OPENAI_REASONING_EFFORT_LABELS, type OpenaiReasoningEffort } from "@shared/ExtensionMessage"
import { motion } from "framer-motion"
import { CheckIcon, ChevronDownIcon, FastForwardIcon, LockKeyholeIcon } from "lucide-react"
import DiracRulesToggleModal from "@/features/dirac-rules/components/DiracRulesToggleModal"
import { cn } from "@/lib/utils"
import { Popover, PopoverContent, PopoverTrigger } from "@/shared/ui/popover"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/shared/ui/tooltip"
import { TaskStatusIndicator } from "../components/TaskStatusIndicator"
import { InputDecorator, ModularInputContext } from "../types"

interface ActionDecoratorProps {
	onModeToggle: (context: ModularInputContext) => void
	mode: "plan" | "act"
	modeSwitchingDisabled?: boolean
	modeSwitchingExplanation?: string
	modelDisplayName: string
	fastModeSupported: boolean
	fastModeEnabled: boolean
	fastModeError?: string
	isUpdatingFastMode: boolean
	onFastModeToggle: () => Promise<void>
	onModelButtonClick: () => void
	modelProviderPresets: ModelProviderPreset[]
	activeModelProviderPresetId?: string
	onModelProviderPresetSelect: (presetId: string) => Promise<void>
	modelPresetError?: string
	isActivatingModelPreset: boolean
	supportsReasoningEffort: boolean
	reasoningEffort: OpenaiReasoningEffort
	reasoningEffortOptions: readonly OpenaiReasoningEffort[]
	onReasoningEffortSelect: (effort: OpenaiReasoningEffort) => Promise<void>
	reasoningEffortError?: string
	isUpdatingReasoningEffort: boolean
	sendingDisabled?: boolean
	taskStatus?: TaskStatus
	togglePlanActKeys?: string
}

const modeSwitchClasses = cn(
	"flex items-center bg-transparent border border-input-border rounded-md overflow-hidden cursor-pointer transition-all duration-200 hover:border-ring/40 select-none relative h-6 w-fit min-w-[112px]",
	"font-mono text-xs tracking-tight whitespace-nowrap",
)

export const createActionDecorator = (props: ActionDecoratorProps): InputDecorator => ({
	id: "actions",
	renderAction: (context: ModularInputContext) => (
		<div className="flex justify-between items-center w-full backdrop-blur-sm rounded-md">
			<div className="flex min-w-0 flex-1 items-center gap-1">
				<DiracRulesToggleModal />

				<div className="relative flex min-w-0 flex-1 items-center gap-1 ml-2 mr-2">
					<div className="flex min-w-0 max-w-full items-center gap-1">
						<button
							className={cn(
								"flex h-5 min-w-0 max-w-full select-none items-center border-0 bg-transparent px-0 text-xs outline-none",
								"text-(--vscode-descriptionForeground) hover:text-(--vscode-foreground) hover:underline focus:text-(--vscode-foreground) focus:underline active:text-(--vscode-foreground) active:underline",
							)}
							onClick={props.onModelButtonClick}
							title="Open API Settings"
							type="button">
							<span className="min-w-0 overflow-hidden text-ellipsis whitespace-nowrap text-xs">
								{props.modelDisplayName}
							</span>
						</button>
						{props.fastModeSupported && (
							<Tooltip>
								<TooltipContent>
									{props.fastModeError || (props.fastModeEnabled ? "Disable Fast Mode" : "Enable Fast Mode")}
								</TooltipContent>
								<TooltipTrigger asChild>
									<button
										aria-label={props.fastModeEnabled ? "Disable Fast Mode" : "Enable Fast Mode"}
										aria-pressed={props.fastModeEnabled}
										className={cn(
											"flex size-5 shrink-0 items-center justify-center rounded-sm bg-transparent p-0 transition-colors hover:bg-(--vscode-toolbar-hoverBackground) disabled:cursor-wait disabled:opacity-60",
											props.fastModeEnabled
												? "text-(--vscode-foreground)"
												: "text-(--vscode-descriptionForeground) opacity-50 hover:opacity-100",
										)}
										data-testid="fast-mode-toggle"
										disabled={props.isUpdatingFastMode}
										onClick={() => void props.onFastModeToggle()}
										type="button">
										<FastForwardIcon size={13} strokeWidth={2.5} />
									</button>
								</TooltipTrigger>
							</Tooltip>
						)}
						<Popover>
							<PopoverTrigger asChild>
								<button
									aria-label="Quick switch model"
									className="flex size-5 shrink-0 items-center justify-center rounded-sm bg-transparent p-0 hover:bg-(--vscode-toolbar-hoverBackground)"
									style={{
										color:
											props.mode === "plan"
												? "var(--vscode-activityWarningBadge-background)"
												: "var(--vscode-focusBorder)",
									}}
									type="button">
									<ChevronDownIcon size={12} strokeWidth={2.5} />
								</button>
							</PopoverTrigger>
							<PopoverContent align="start" className="w-72 p-1 text-(--vscode-menu-foreground)" side="top">
								<div className="max-h-64 overflow-y-auto py-1">
									{props.modelProviderPresets.map((preset) => (
										<button
											className="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-xs text-(--vscode-menu-foreground) hover:bg-(--vscode-list-hoverBackground) disabled:cursor-wait disabled:opacity-60"
											disabled={props.isActivatingModelPreset}
											key={preset.id}
											onClick={() => void props.onModelProviderPresetSelect(preset.id)}
											type="button">
											<span
												className="flex size-3 shrink-0 items-center justify-center"
												style={{
													color:
														props.mode === "plan"
															? "var(--vscode-activityWarningBadge-background)"
															: "var(--vscode-focusBorder)",
												}}>
												{preset.id === props.activeModelProviderPresetId && (
													<CheckIcon size={12} strokeWidth={2.5} />
												)}
											</span>
											<span className="min-w-0 flex-1">
												<span className="block truncate text-(--vscode-menu-foreground)">
													{preset.modelInfo?.name || preset.modelId}
												</span>
												<span className="block truncate text-[10px] text-(--vscode-descriptionForeground)">
													{preset.provider}
													{preset.openAiProfileName ? ` · ${preset.openAiProfileName}` : ""}
												</span>
											</span>
										</button>
									))}
									{props.modelPresetError && (
										<p
											className="mx-2 my-1 text-[10px] leading-4 text-(--vscode-errorForeground)"
											role="alert">
											{props.modelPresetError}
										</p>
									)}
									<button
										className="mt-1 w-full border-t border-(--vscode-menu-separatorBackground) px-2 py-2 text-left text-xs text-(--vscode-descriptionForeground) hover:bg-(--vscode-list-hoverBackground) hover:text-(--vscode-menu-foreground)"
										onClick={props.onModelButtonClick}
										type="button">
										Manage models…
									</button>
								</div>
							</PopoverContent>
						</Popover>
						{props.supportsReasoningEffort && (
							<Popover>
								<PopoverTrigger asChild>
									<button
										aria-label={`Reasoning effort: ${props.reasoningEffort}`}
										className="flex h-5 shrink-0 items-center gap-0.5 rounded-sm bg-transparent px-1 text-xs capitalize text-(--vscode-descriptionForeground) hover:bg-(--vscode-toolbar-hoverBackground) hover:text-(--vscode-foreground) disabled:cursor-wait disabled:opacity-60"
										disabled={props.isUpdatingReasoningEffort}
										title="Change reasoning effort"
										type="button">
										<span>{OPENAI_REASONING_EFFORT_LABELS[props.reasoningEffort]}</span>
										<ChevronDownIcon size={10} strokeWidth={2.5} />
									</button>
								</PopoverTrigger>
								<PopoverContent align="start" className="w-44 p-1 text-(--vscode-menu-foreground)" side="top">
									<p className="px-2 pb-1 pt-1 text-[10px] text-(--vscode-descriptionForeground)">
										Reasoning effort
									</p>
									{props.reasoningEffortOptions.map((effort) => (
										<button
											className="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-xs capitalize text-(--vscode-menu-foreground) hover:bg-(--vscode-list-hoverBackground) disabled:cursor-wait disabled:opacity-60"
											disabled={props.isUpdatingReasoningEffort}
											key={effort}
											onClick={() => void props.onReasoningEffortSelect(effort)}
											type="button">
											<span
												className="flex size-3 shrink-0 items-center justify-center"
												style={{
													color:
														props.mode === "plan"
															? "var(--vscode-activityWarningBadge-background)"
															: "var(--vscode-focusBorder)",
												}}>
												{effort === props.reasoningEffort && <CheckIcon size={12} strokeWidth={2.5} />}
											</span>
											{OPENAI_REASONING_EFFORT_LABELS[effort]}
										</button>
									))}
									{props.reasoningEffortError && (
										<p
											className="mx-2 my-1 text-[10px] leading-4 text-(--vscode-errorForeground)"
											role="alert">
											{props.reasoningEffortError}
										</p>
									)}
								</PopoverContent>
							</Popover>
						)}
					</div>
					<TaskStatusIndicator className="ml-auto hidden min-[360px]:flex" status={props.taskStatus} />
				</div>
			</div>

			{props.modeSwitchingDisabled && props.mode === "act" ? (
				<Tooltip>
					<TooltipContent className="px-2 text-xs" side="top">
						{props.modeSwitchingExplanation}
					</TooltipContent>
					<TooltipTrigger asChild>
						<button
							aria-disabled="true"
							aria-label={`Act mode locked. ${props.modeSwitchingExplanation ?? "Mode switching is unavailable."}`}
							className="flex h-6 shrink-0 cursor-default items-center gap-1.5 rounded-md border border-input-border bg-transparent px-2 font-mono text-xs text-(--vscode-descriptionForeground)"
							data-testid="mode-switch"
							title={props.modeSwitchingExplanation}
							type="button">
							<LockKeyholeIcon aria-hidden="true" size={11} />
							Act
						</button>
					</TooltipTrigger>
				</Tooltip>
			) : (
				<Tooltip>
					<TooltipContent className="flex flex-col gap-1 px-2 text-xs" side="top">
						{`In ${props.mode === "act" ? "Act" : "Plan"} mode, Dirac will ${props.mode === "act" ? "complete the task immediately" : "gather information to architect a plan"}`}
						{props.togglePlanActKeys && (
							<p className="mb-0 text-xs text-description/80">
								Toggle w/ <kbd className="mx-1 text-muted-foreground">{props.togglePlanActKeys}</kbd>
							</p>
						)}
					</TooltipContent>
					<TooltipTrigger asChild>
						<button
							aria-label={`Switch to ${props.mode === "act" ? "Plan" : "Act"} mode`}
							className={modeSwitchClasses}
							data-testid="mode-switch"
							onClick={() => props.onModeToggle(context)}
							type="button">
							<motion.div
								animate={{
									x: props.mode === "act" ? "100%" : "0%",
									backgroundColor:
										props.mode === "plan"
											? "var(--vscode-activityWarningBadge-background)"
											: "var(--vscode-focusBorder)",
								}}
								className="absolute h-full w-1/2 opacity-90"
								initial={false}
								transition={{ bounce: 0, duration: 0.15, type: "spring" }}
							/>
							{["Plan", "Act"].map((m) => {
								const isSelected = props.mode === m.toLowerCase()
								return (
									<div
										aria-hidden="true"
										className={cn(
											"z-10 flex flex-1 items-center justify-center gap-1.5 px-3 text-center transition-colors duration-150",
											isSelected
												? "text-white font-bold"
												: "text-(--vscode-input-placeholderForeground) hover:text-(--vscode-input-foreground)",
										)}
										key={m}>
										{m === "Plan" ? (
											<span className="codicon codicon-lightbulb text-[10px]" />
										) : (
											<span className="codicon codicon-zap text-[10px]" />
										)}
										{m}
									</div>
								)
							})}
						</button>
					</TooltipTrigger>
				</Tooltip>
			)}
		</div>
	),
})
