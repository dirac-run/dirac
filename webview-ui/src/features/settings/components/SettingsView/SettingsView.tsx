import type { ExtensionMessage } from "@shared/ExtensionMessage"
import { ResetStateRequest } from "@shared/proto/dirac/state"
import {
	CheckCheck,
	FlaskConical,
	Info,
	type LucideIcon,
	Puzzle,
	SlidersHorizontal,
	SquareMousePointer,
	SquareTerminal,
	Wrench,
} from "lucide-react"
import { useCallback, useEffect, useMemo, useState } from "react"
import { useEvent } from "react-use"
import { useUserStore } from "@/entities/user/store/userStore"
import { useSettingsStore } from "@/features/settings/store/settingsStore"
import { cn } from "@/lib/utils"
import { StateServiceClient } from "@/shared/api/grpc-client"
import { Tab, TabContent, TabList, TabTrigger } from "@/shared/ui/Tab"
import ViewHeader from "@/shared/ui/ViewHeader"
import SectionHeader from "../SectionHeader"
import AboutSection from "../sections/AboutSection"
import ApiConfigurationSection from "../sections/ApiConfigurationSection"
import BrowserSettingsSection from "../sections/BrowserSettingsSection"
import DebugSection from "../sections/DebugSection"
import FeatureSettingsSection from "../sections/FeatureSettingsSection"
import GeneralSettingsSection from "../sections/GeneralSettingsSection"
import TerminalSettingsSection from "../sections/TerminalSettingsSection"
import ToolTogglePanel from "../sections/ToolTogglePanel"

const IS_DEV = process.env.IS_DEV

// Tab definitions
type SettingsTabID = "api-config" | "features" | "tools" | "browser" | "terminal" | "general" | "about" | "debug"
interface SettingsTab {
	id: SettingsTabID
	name: string
	tooltipText: string
	headerText: string
	icon: LucideIcon
	hidden?: (params?: { activeOrganization: any | null }) => boolean
}

export const SETTINGS_TABS: SettingsTab[] = [
	{
		id: "api-config",
		name: "API Configuration",
		tooltipText: "API Configuration",
		headerText: "API Configuration",
		icon: SlidersHorizontal,
	},
	{
		id: "features",
		name: "Features",
		tooltipText: "Feature Settings",
		headerText: "Feature Settings",
		icon: CheckCheck,
	},
	{
		id: "tools",
		name: "Tools",
		tooltipText: "Tool Settings",
		headerText: "Tool Settings",
		icon: Puzzle,
	},
	{
		id: "browser",
		name: "Browser",
		tooltipText: "Browser Settings",
		headerText: "Browser Settings",
		icon: SquareMousePointer,
	},
	{
		id: "terminal",
		name: "Terminal",
		tooltipText: "Terminal Settings",
		headerText: "Terminal Settings",
		icon: SquareTerminal,
	},
	{
		id: "general",
		name: "General",
		tooltipText: "General Settings",
		headerText: "General Settings",
		icon: Wrench,
	},
	{
		id: "about",
		name: "About",
		tooltipText: "About Dirac",
		headerText: "About",
		icon: Info,
	},
	// Only show in dev mode
	{
		id: "debug",
		name: "Debug",
		tooltipText: "Debug Tools",
		headerText: "Debug",
		icon: FlaskConical,
		hidden: () => !IS_DEV,
	},
]

type SettingsViewProps = {
	onDone: () => void
	targetSection?: string
}

// Helper to render section header - moved outside component for better performance
const renderSectionHeader = (tabId: string) => {
	const tab = SETTINGS_TABS.find((t) => t.id === tabId)
	if (!tab) {
		return null
	}

	return (
		<SectionHeader>
			<div className="flex items-center gap-2">
				<tab.icon className="w-4" />
				<div>{tab.headerText}</div>
			</div>
		</SectionHeader>
	)
}

const TAB_CONTENT_MAP: Record<SettingsTabID, React.FC<any>> = {
	"api-config": ApiConfigurationSection,
	features: FeatureSettingsSection,
	tools: ToolTogglePanel,
	browser: BrowserSettingsSection,
	terminal: TerminalSettingsSection,
	general: GeneralSettingsSection,
	about: AboutSection,
	debug: DebugSection,
}

const SettingsView = ({ onDone, targetSection }: SettingsViewProps) => {
	const version = useSettingsStore((state) => state.version)
	const environment = useSettingsStore((state) => state.environment)
	const activeOrganization = useUserStore((state) => state.activeOrganization)

	const visibleTabs = useMemo(() => SETTINGS_TABS.filter((tab) => !tab.hidden?.({ activeOrganization })), [activeOrganization])
	const visibleTabIds = useMemo(() => new Set(visibleTabs.map((tab) => tab.id)), [visibleTabs])
	const resolveTab = useCallback(
		(tabId?: string): SettingsTabID =>
			tabId && visibleTabIds.has(tabId as SettingsTabID) ? (tabId as SettingsTabID) : visibleTabs[0]?.id || "api-config",
		[visibleTabIds, visibleTabs],
	)
	const [activeTab, setActiveTab] = useState<SettingsTabID>(() => resolveTab(targetSection))

	useEffect(() => {
		setActiveTab((current) => resolveTab(targetSection || current))
	}, [resolveTab, targetSection])

	const handleMessage = useCallback(
		(event: MessageEvent) => {
			const message: ExtensionMessage = event.data
			if (message.type !== "grpc_response") return

			const grpcMessage = message.grpc_response?.message
			if (grpcMessage?.key !== "scrollToSettings" || !grpcMessage.value) return

			const tabId = grpcMessage.value
			if (visibleTabIds.has(tabId as SettingsTabID)) {
				setActiveTab(tabId as SettingsTabID)
				return
			}

			requestAnimationFrame(() => {
				const element = document.getElementById(tabId)
				if (!element) return
				element.scrollIntoView({ behavior: "smooth", block: "center" })
				element.classList.add("settings-target-highlight")
				window.setTimeout(() => element.classList.remove("settings-target-highlight"), 1200)
			})
		},
		[visibleTabIds],
	)

	useEvent("message", handleMessage)

	const handleResetState = useCallback(async (resetGlobalState?: boolean) => {
		try {
			await StateServiceClient.resetState(ResetStateRequest.create({ global: resetGlobalState }))
		} catch (error: any) {
			console.error("Failed to reset state:", error)
		}
	}, [])

	const ActiveContent = useMemo(() => {
		const Component = TAB_CONTENT_MAP[activeTab]
		if (!Component) return null

		const props: any = { renderSectionHeader }
		if (activeTab === "debug") props.onResetState = handleResetState
		if (activeTab === "about") props.version = version
		return <Component {...props} />
	}, [activeTab, handleResetState, version])

	return (
		<Tab>
			<ViewHeader environment={environment} onDone={onDone} title="Settings" />

			<div className="flex flex-1 overflow-hidden">
				<TabList
					aria-label="Settings sections"
					aria-orientation="vertical"
					className="shrink-0 flex flex-col overflow-y-auto border-r border-sidebar-background"
					onValueChange={(value) => setActiveTab(resolveTab(value))}
					value={activeTab}>
					{visibleTabs.map((tab) => (
						<TabTrigger
							aria-controls={`settings-panel-${tab.id}`}
							aria-label={tab.tooltipText}
							className={cn(
								"whitespace-nowrap overflow-hidden h-12 box-border flex items-center border-l-2 border-transparent text-foreground opacity-70 bg-transparent hover:bg-list-hover px-4 cursor-pointer gap-2",
								activeTab === tab.id && "opacity-100 border-l-foreground bg-selection",
							)}
							data-testid={`tab-${tab.id}`}
							id={`settings-tab-${tab.id}`}
							key={tab.id}
							title={tab.tooltipText}
							value={tab.id}>
							<tab.icon aria-hidden="true" className="w-4 h-4" />
							<span className="hidden sm:block">{tab.name}</span>
						</TabTrigger>
					))}
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
