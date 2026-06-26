import { VSCodeButton } from "@vscode/webview-ui-toolkit/react"
import { AtSignIcon, PlusIcon } from "lucide-react"
import { motion } from "framer-motion"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/shared/ui/tooltip"
import { cn } from "@/lib/utils"
import DiracRulesToggleModal from "@/features/dirac-rules/components/DiracRulesToggleModal"
import { InputDecorator, ModularInputContext } from "../types"
import type { TaskStatus } from "@shared/ExtensionMessage"
import { TaskStatusIndicator } from "../components/TaskStatusIndicator"
interface ActionDecoratorProps {
	onModeToggle: (context: ModularInputContext) => void
	mode: "plan" | "act"
	modelDisplayName: string
	onModelButtonClick: () => void
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

				<div className="relative flex min-w-0 flex-1 items-center gap-2 ml-2 mr-2">
					<a
						className={cn(
							"px-0 h-5 min-w-0 flex-1 flex items-center text-[10px] outline-none select-none",
							"text-(--vscode-descriptionForeground) hover:text-(--vscode-foreground) hover:underline focus:text-(--vscode-foreground) focus:underline active:text-(--vscode-foreground) active:underline",
						)}
						onClick={props.onModelButtonClick}
						role="button"
						tabIndex={0}
						title="Open API Settings">
						<div className="w-full min-w-0 overflow-hidden text-ellipsis whitespace-nowrap text-xs">
							{props.modelDisplayName}
						</div>
					</a>
					<TaskStatusIndicator className="hidden min-[360px]:flex" status={props.taskStatus} />
				</div>
			</div>

			<Tooltip>
				<TooltipContent className="text-xs px-2 flex flex-col gap-1" side="top">
					{`In ${props.mode === "act" ? "Act" : "Plan"} mode, Dirac will ${
						props.mode === "act" ? "complete the task immediately" : "gather information to architect a plan"
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
