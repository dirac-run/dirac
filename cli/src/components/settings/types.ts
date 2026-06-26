import type { Controller } from "@/core/controller"

export type SettingsTab = "api" | "auto-approve" | "features" | "tools" | "other"

export interface ListItem {
	key: string
	label: string
	type: "checkbox" | "readonly" | "editable" | "separator" | "header" | "spacer" | "action" | "cycle" | "object"
	value: any
	description?: string
	isSubItem?: boolean
	parentKey?: string
}

export interface SettingsPanelContentProps {
	onClose: () => void
	controller?: Controller
	initialMode?: "model-picker" | "featured-models" | "provider-picker"
	initialModelKey?: "actModelId" | "planModelId"
}
