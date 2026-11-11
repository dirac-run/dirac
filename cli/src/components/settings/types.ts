import type { Controller } from "@/core/controller"

export enum SettingsTab {
	MODELS_API = "models-api",
	UTILITY_MODEL = "utility-model",
	APPROVALS = "approvals",
	RESPONSES_CONTEXT = "responses-context",
	RUNNING_TASKS = "running-tasks",
	TOOLS = "tools",
	TERMINAL = "terminal",
	SANDBOX = "sandbox",
	GENERAL = "general",
}

export enum SettingsItemType {
	CHECKBOX = "checkbox",
	READONLY = "readonly",
	EDITABLE = "editable",
	SEPARATOR = "separator",
	HEADER = "header",
	SPACER = "spacer",
	ACTION = "action",
	CYCLE = "cycle",
	OBJECT = "object",
}

export enum SettingsNavigationDirection {
	UP = "up",
	DOWN = "down",
}

export interface ListItem {
	key: string
	label: string
	type: SettingsItemType
	value: any
	cycleOptions?: readonly string[]
	description?: string
	expandedHelp?: string
	keywords?: string[]
	persistentHelp?: string
	alwaysShowHelp?: boolean
	helpTone?: "muted" | "warning" | "error"
	isSubItem?: boolean
	parentKey?: string
}

export interface SettingsSearchResult {
	id: string
	destination: SettingsTab
	destinationLabel: string
	itemIndex: number
	item: ListItem
	searchText: string
}

export interface SettingsPanelContentProps {
	onClose: () => void
	controller?: Controller
	initialMode?: "model-picker" | "featured-models" | "provider-picker"
	initialModelKey?: "actModelId" | "planModelId"
}
