import { VSCodeButton } from "@vscode/webview-ui-toolkit/react"
import { AtSignIcon, CheckIcon, ChevronDownIcon, PlusIcon } from "lucide-react"
import { motion } from "framer-motion"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/shared/ui/tooltip"
import { cn } from "@/lib/utils"
import DiracRulesToggleModal from "@/features/dirac-rules/components/DiracRulesToggleModal"
import { InputDecorator, ModularInputContext } from "../types"
import type { TaskStatus } from "@shared/ExtensionMessage"
import type { OpenaiReasoningEffort } from "@shared/ExtensionMessage"
import { TaskStatusIndicator } from "../components/TaskStatusIndicator"
import type { ModelProviderPreset } from "@shared/api"
import { Popover, PopoverContent, PopoverTrigger } from "@/shared/ui/popover"
interface ActionDecoratorProps {
	onModeToggle: (context: ModularInputContext) => void
	mode: "plan" | "act"
	modelDisplayName: string
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
	onSelectFilesAndImages: () => void
	shouldDisableFilesAndImages: boolean
	sendingDisabled?: boolean
	taskStatus?: TaskStatus
	togglePlanActKeys?: string
}

const modeSwitchClasses = cn(
	"flex items-center bg-transparent border border-input-border rounded-md overflow-hidden cursor-pointer transition-all duration-200 hover:border-ring/40 select-none relative h-6 w-fit min-w-[112px]",
	"font-mono text-[9px] tracking-tight whitespace-nowrap",
)

export const createActionDecorator = (props: ActionDecoratorProps): InputDecorator => ({
	id: "actions",
	renderAction: (context: ModularInputContext) => (
		<div className="flex justify-between items-center w-full backdrop-blur-sm rounded-md">
			<div className="flex min-w-0 flex-1 items-center gap-1">
				<Tooltip>
					<TooltipContent>Add Context</TooltipContent>
					<TooltipTrigger>
						<motion.div whileHover={{ scale: 1.1 }} whileTap={{ scale: 0.9 }}>
							<VSCodeButton
								appearance="icon"
								aria-label="Add Context"
								className="p-0 m-0 flex items-center"
								data-testid="context-button"
								onClick={() => {
									context.textAreaRef.current?.focus()
									const currentValue = context.inputValue
									const newValue =
										currentValue.endsWith(" ") || !currentValue ? currentValue + "@" : currentValue + " @"
									context.setInputValue(newValue)
									// Trigger mention trait if needed
								}}>
								<div className="flex items-center gap-[3px] text-[10px] whitespace-nowrap min-w-0 w-full">
									<AtSignIcon size={12} />
								</div>
							</VSCodeButton>
						</motion.div>
					</TooltipTrigger>
				</Tooltip>

				<Tooltip>
					<TooltipContent>Add Files & Images</TooltipContent>
					<TooltipTrigger>
						<motion.div whileHover={{ scale: 1.1 }} whileTap={{ scale: 0.9 }}>
							<VSCodeButton
								appearance="icon"
								aria-label="Add Files & Images"
								className="p-0 m-0 flex items-center"
								data-testid="files-button"
								disabled={props.shouldDisableFilesAndImages}
								onClick={props.onSelectFilesAndImages}>
								<div className="flex items-center gap-[3px] text-[10px] whitespace-nowrap min-w-0 w-full">
									<PlusIcon size={13} />
								</div>
							</VSCodeButton>
						</motion.div>
					</TooltipTrigger>
				</Tooltip>

				<DiracRulesToggleModal />

				<div className="relative flex min-w-0 flex-1 items-center gap-1 ml-2 mr-2">
					<div className="flex min-w-0 max-w-full items-center gap-1">
						<a
							className={cn(
								"flex h-5 min-w-0 max-w-full items-center px-0 text-[10px] outline-none select-none",
								"text-(--vscode-descriptionForeground) hover:text-(--vscode-foreground) hover:underline focus:text-(--vscode-foreground) focus:underline active:text-(--vscode-foreground) active:underline",
							)}
							onClick={props.onModelButtonClick}
							role="button"
							tabIndex={0}
							title="Open API Settings">
							<span className="min-w-0 overflow-hidden text-ellipsis whitespace-nowrap text-xs">
								{props.modelDisplayName}
							</span>
						</a>
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
							<PopoverContent
								align="start"
								className="w-72 p-1 text-(--vscode-menu-foreground)"
								side="top">
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
												{preset.id === props.activeModelProviderPresetId && <CheckIcon size={12} strokeWidth={2.5} />}
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
										<p className="mx-2 my-1 text-[10px] leading-4 text-(--vscode-errorForeground)" role="alert">
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
										className="flex h-5 shrink-0 items-center gap-0.5 rounded-sm bg-transparent px-1 text-[10px] capitalize text-(--vscode-descriptionForeground) hover:bg-(--vscode-toolbar-hoverBackground) hover:text-(--vscode-foreground) disabled:cursor-wait disabled:opacity-60"
										disabled={props.isUpdatingReasoningEffort}
										title="Change reasoning effort"
										type="button">
										<span>{props.reasoningEffort}</span>
										<ChevronDownIcon size={10} strokeWidth={2.5} />
									</button>
								</PopoverTrigger>
								<PopoverContent
									align="start"
									className="w-44 p-1 text-(--vscode-menu-foreground)"
									side="top">
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
											{effort}
										</button>
									))}
									{props.reasoningEffortError && (
										<p className="mx-2 my-1 text-[10px] leading-4 text-(--vscode-errorForeground)" role="alert">
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

			<Tooltip>
				<TooltipContent className="text-xs px-2 flex flex-col gap-1" side="top">
					{`In ${props.mode === "act" ? "Act" : "Plan"} mode, Dirac will ${props.mode === "act" ? "complete the task immediately" : "gather information to architect a plan"
						}`}
					{props.togglePlanActKeys && (
						<p className="text-description/80 text-xs mb-0">
							Toggle w/ <kbd className="text-muted-foreground mx-1">{props.togglePlanActKeys}</kbd>
						</p>
					)}
				</TooltipContent>
				<TooltipTrigger>
					<div className={modeSwitchClasses} data-testid="mode-switch" onClick={() => props.onModeToggle(context)}>
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
									aria-checked={isSelected}
									className={cn(
										"flex-1 z-10 text-center transition-colors duration-150 flex items-center justify-center gap-1.5 px-3",
										isSelected
											? "text-white font-bold"
											: "text-(--vscode-input-placeholderForeground) hover:text-(--vscode-input-foreground)",
									)}
									key={m}
									role="switch">
									{m === "Plan" ? (
										<span className="codicon codicon-lightbulb text-[10px]" />
									) : (
										<span className="codicon codicon-zap text-[10px]" />
									)}
									{m}
								</div>
							)
						})}
					</div>
				</TooltipTrigger>
			</Tooltip>
		</div>
	),
})
