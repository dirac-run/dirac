import { ActionMetadata } from "./types"

export const ACTION_METADATA: ActionMetadata[] = [
	{
		id: "readFiles",
		label: "Read project files",
		shortName: "Read",
		icon: "codicon-search",
		subAction: {
			id: "readFilesExternally",
			label: "Read all files",
			shortName: "Read (all)",
			icon: "codicon-folder-opened",
			parentActionId: "readFiles",
		},
	},
	{
		id: "editFiles",
		label: "Edit project files",
		shortName: "Edit",
		icon: "codicon-edit",
		subAction: {
			id: "editFilesExternally",
			label: "Edit all files",
			shortName: "Edit (all)",
			icon: "codicon-files",
			parentActionId: "editFiles",
		},
	},
	{
		id: "executeCommands",
		label: "Auto-approve safe commands",
		shortName: "Safe Commands",
		icon: "codicon-terminal",
	},
	{
		id: "useBrowser",
		label: "Use the browser",
		shortName: "Browser",
		icon: "codicon-globe",
	},
	{
		id: "applyDiff",
		label: "Apply edits with anchors",
		shortName: "Edit (anchors)",
		icon: "codicon-edit",
	},
]

export const NOTIFICATIONS_SETTING: ActionMetadata = {
	id: "enableNotifications",
	label: "Enable notifications",
	shortName: "Notifications",
	icon: "codicon-bell",
}
