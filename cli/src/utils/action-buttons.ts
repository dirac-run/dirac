import { UIActionButtonType, type UIActionButton } from "@shared/ExtensionMessage"

const HIDDEN_GLOBAL_ACTIONS = new Set<UIActionButtonType>([UIActionButtonType.CANCEL])

export function getVisibleGlobalActionButtons(buttons: UIActionButton[]): UIActionButton[] {
	return buttons.filter((button) => !HIDDEN_GLOBAL_ACTIONS.has(button.action))
}
