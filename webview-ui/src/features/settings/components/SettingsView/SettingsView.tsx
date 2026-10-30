import type { ExtensionMessage } from "@shared/ExtensionMessage"
import { ResetStateRequest } from "@shared/proto/dirac/state"
import { SETTINGS_DESTINATIONS, type SettingsDestinationId } from "@shared/settings-presentation"
import {
	Bot,
	BrainCircuit,
	Globe2,
	ListChecks,
	type LucideIcon,
	MessageSquareText,
	Puzzle,
	Settings2,
	ShieldCheck,
	SquareTerminal,
} from "lucide-react"
import { useCallback, useEffect, useMemo, useState } from "react"
import { useEvent } from "react-use"
import { useSettingsStore } from "@/features/settings/store/settingsStore"
import { cn } from "@/lib/utils"
import { StateServiceClient } from "@/shared/api/grpc-client"
import { Tab, TabContent, TabList, TabTrigger } from "@/shared/ui/Tab"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/shared/ui/tooltip"
import ViewHeader from "@/shared/ui/ViewHeader"
import SectionHeader from "../SectionHeader"
import ApiConfigurationSection from "../sections/ApiConfigurationSection"
import ApprovalsSettingsSection from "../sections/ApprovalsSettingsSection"
import BrowserSettingsSection from "../sections/BrowserSettingsSection"
import GeneralSettingsSection from "../sections/GeneralSettingsSection"
import ResponsesContextSection from "../sections/ResponsesContextSection"
import RunningTasksSection from "../sections/RunningTasksSection"
import TerminalSettingsSection from "../sections/TerminalSettingsSection"
import ToolsSettingsSection from "../sections/ToolsSettingsSection"
import UtilityModelSection from "../sections/UtilityModelSection"

const IS_DEV = process.env.IS_DEV === '"true"'

type SettingsTabID = SettingsDestinationId
interface SettingsTab {
	id: SettingsTabID
	icon: LucideIcon
}

export const SETTINGS_TABS: SettingsTab[] = [
	{ id: "models-api", icon: BrainCircuit },
	{ id: "utility-model", icon: Bot },
	{ id: "approvals", icon: ShieldCheck },
	{ id: "responses-context", icon: MessageSquareText },
	{ id: "running-tasks", icon: ListChecks },
	{ id: "tools", icon: Puzzle },
	{ id: "terminal", icon: SquareTerminal },
	{ id: "browser", icon: Globe2 },
	{ id: "general", icon: Settings2 },
]

interface ResolvedTarget {
	tab: SettingsTabID
	focusId?: string
}
const TARGET_ALIASES: Record<string, ResolvedTarget> = {
	"api-config": { tab: "models-api" },
	"utility-model": { tab: "utility-model" },
	"user-approved-commands": {
		tab: "approvals",
		focusId: "user-approved-commands",
	},
	features: { tab: "running-tasks" },
	tools: { tab: "tools" },
	browser: { tab: "browser" },
	terminal: { tab: "terminal" },
	general: { tab: "general" },
	about: { tab: "general", focusId: "about" },
	debug: { tab: "general", focusId: "advanced-diagnostics" },
	"auto-approve": { tab: "approvals", focusId: "auto-approve-actions" },
	"approved-command-rules": { tab: "approvals", focusId: "user-approved-commands" },
	"strict-plan-mode": { tab: "approvals", focusId: "approval-policies" },
	yolo: { tab: "approvals", focusId: "yolo-mode" },
	"auto-compact": { tab: "responses-context", focusId: "auto-condense-conversations" },
	"auto-condense-conversations": { tab: "responses-context", focusId: "auto-condense-conversations" },
	"low-verbosity-responses": { tab: "responses-context", focusId: "low-verbosity-responses" },
	subagents: { tab: "running-tasks", focusId: "subagents" },
	"parallel-tool-calling": { tab: "running-tasks", focusId: "parallel-tool-calling" },
	"background-edit": { tab: "running-tasks", focusId: "background-edit" },
	checkpoints: { tab: "running-tasks", focusId: "checkpoints" },
	worktrees: { tab: "running-tasks", focusId: "worktrees" },
	"dirac-web-tools": { tab: "tools", focusId: "web-search-fetch" },
	hooks: { tab: "tools", focusId: "hooks" },
}

export function resolveSettingsTarget(target?: string): ResolvedTarget {
	if (!target) return { tab: "models-api" }
	if (SETTINGS_TABS.some((tab) => tab.id === target)) return { tab: target as SettingsTabID }
	return TARGET_ALIASES[target] ?? { tab: "running-tasks", focusId: target }
}

const TAB_CONTENT_MAP: Record<SettingsTabID, React.FC<any>> = {
	"models-api": ApiConfigurationSection,
	"utility-model": UtilityModelSection,
	approvals: ApprovalsSettingsSection,
	"responses-context": ResponsesContextSection,
	"running-tasks": RunningTasksSection,
	tools: ToolsSettingsSection,
	terminal: TerminalSettingsSection,
	browser: BrowserSettingsSection,
	general: GeneralSettingsSection,
}

interface SettingsViewProps {
	onDone: () => void
	targetSection?: string
}

const SettingsView = ({ onDone, targetSection }: SettingsViewProps) => {
	const version = useSettingsStore((state) => state.version)
	const environment = useSettingsStore((state) => state.environment)
	const initialTarget = resolveSettingsTarget(targetSection)
	const [activeTab, setActiveTab] = useState<SettingsTabID>(initialTarget.tab)
	const [focusTarget, setFocusTarget] = useState(initialTarget.focusId)

	const selectTarget = useCallback((target?: string) => {
		const resolved = resolveSettingsTarget(target)
		setActiveTab(resolved.tab)
		setFocusTarget(resolved.focusId)
	}, [])
	useEffect(() => selectTarget(targetSection), [selectTarget, targetSection])
	useEffect(() => {
		if (!focusTarget) return
		requestAnimationFrame(() => {
			const element = document.getElementById(focusTarget)
			if (!element) return
			element.scrollIntoView({ behavior: "smooth", block: "center" })
			element.classList.add("settings-target-highlight")
			window.setTimeout(() => element.classList.remove("settings-target-highlight"), 1200)
			setFocusTarget(undefined)
		})
	}, [activeTab, focusTarget])

	const handleMessage = useCallback(
		(event: MessageEvent) => {
			const message: ExtensionMessage = event.data
			if (message.type !== "grpc_response") return
			const grpcMessage = message.grpc_response?.message
			if (grpcMessage?.key === "scrollToSettings" && grpcMessage.value) selectTarget(grpcMessage.value)
		},
		[selectTarget],
	)
	useEvent("message", handleMessage)

	const handleResetState = useCallback(async (resetGlobalState?: boolean) => {
		try {
			await StateServiceClient.resetState(ResetStateRequest.create({ global: resetGlobalState }))
		} catch (error) {
			console.error("Failed to reset state:", error)
		}
	}, [])

	const renderSectionHeader = useCallback((tabId: string) => {
		const tab = SETTINGS_TABS.find((candidate) => candidate.id === tabId)
		if (!tab) return null
		const presentation = SETTINGS_DESTINATIONS[tab.id]
		return (
			<SectionHeader description={presentation.question}>
				<div className="flex items-center gap-2">
					<tab.icon className="w-4" />
					<div>{presentation.label}</div>
				</div>
			</SectionHeader>
		)
	}, [])

	const ActiveContent = useMemo(() => {
		const Component = TAB_CONTENT_MAP[activeTab]
		const props: any = { renderSectionHeader }
		if (activeTab === "general") {
			if (IS_DEV) props.onResetState = handleResetState
			props.version = version
		}
		return <Component {...props} />
	}, [activeTab, handleResetState, renderSectionHeader, version])

	return (
		<Tab>
			<ViewHeader environment={environment} onDone={onDone} title="Settings" />
			<div className="flex flex-1 overflow-hidden">
				<TabList
					aria-label="Settings destinations"
					aria-orientation="vertical"
					className="settings-tab-list shrink-0 flex flex-col overflow-y-auto border-r border-sidebar-background"
					onValueChange={(value) => setActiveTab(value as SettingsTabID)}
					value={activeTab}>
					{SETTINGS_TABS.map((tab) => {
						const presentation = SETTINGS_DESTINATIONS[tab.id]
						return (
							<Tooltip key={tab.id}>
								<TooltipTrigger asChild>
									<TabTrigger
										aria-controls={`settings-panel-${tab.id}`}
										aria-label={presentation.label}
										className={cn(
											"settings-tab-trigger w-full whitespace-nowrap overflow-hidden h-12 box-border flex items-center border-l-2 border-transparent text-left text-foreground opacity-70 bg-transparent hover:bg-list-hover px-4 cursor-pointer gap-2",
											activeTab === tab.id && "opacity-100 border-l-foreground bg-selection",
										)}
										data-testid={`tab-${tab.id}`}
										id={`settings-tab-${tab.id}`}
										value={tab.id}>
										<tab.icon aria-hidden="true" className="settings-tab-icon w-4 h-4" />
										<span className="settings-tab-label">{presentation.label}</span>
										<span aria-hidden="true" className="settings-tab-compact-label">
											{presentation.compactLabel}
										</span>
									</TabTrigger>
								</TooltipTrigger>
								<TooltipContent
									className="settings-nav-tooltip max-w-xs"
									showArrow={false}
									side="right"
									sideOffset={6}>
									{presentation.webviewTooltip}
								</TooltipContent>
							</Tooltip>
						)
					})}
				</TabList>
				<TabContent
					aria-labelledby={`settings-tab-${activeTab}`}
					className="flex-1 overflow-auto"
					id={`settings-panel-${activeTab}`}
					role="tabpanel">
					{ActiveContent}
				</TabContent>
			</div>
		</Tab>
	)
}

export default SettingsView
