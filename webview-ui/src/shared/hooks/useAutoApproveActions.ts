import { AutoApprovalSettings } from "@shared/AutoApprovalSettings"
import { useCallback } from "react"
import { updateAutoApproveSettings } from "@/features/modular-ui/chat/components/AutoApprove/AutoApproveSettingsAPI"
import { ActionMetadata } from "@/features/modular-ui/chat/components/AutoApprove/types"
import { useSettingsStore } from "@/features/settings/store/settingsStore"

export function useAutoApproveActions() {
	const { autoApprovalSettings, autoApproveAllToggled } = useSettingsStore()

	// Check if action is enabled
	const isChecked = useCallback(
		(action: ActionMetadata): boolean => {
			if (autoApproveAllToggled && action.id !== "enableNotifications") {
				return true
			}

			switch (action.id) {
				case "enableNotifications":
					return autoApprovalSettings.enableNotifications
				default:
					return autoApprovalSettings.actions[action.id as keyof AutoApprovalSettings["actions"]] ?? false
			}
		},
		[autoApprovalSettings, autoApproveAllToggled],
	)

	// Update action state
	const updateAction = useCallback(
		async (action: ActionMetadata, value: boolean) => {
			const actionId = action.id
			const subActionId = action.subAction?.id

			if (actionId === "enableNotifications" || subActionId === "enableNotifications") {
				await updateNotifications(action, value)
				return
			}

			const newActions = {
				...autoApprovalSettings.actions,
				[actionId]: value,
			}

			if (value === false && subActionId) {
					newActions[subActionId as keyof AutoApprovalSettings["actions"]] = false
			}

			if (value === true && action.parentActionId) {
				newActions[action.parentActionId as keyof AutoApprovalSettings["actions"]] = true
			}

			await updateAutoApproveSettings({
				...autoApprovalSettings,
				version: (autoApprovalSettings.version ?? 1) + 1,
				actions: newActions,
			})
		},
		[autoApprovalSettings],
	)

	// Update notifications setting
	const updateNotifications = useCallback(
		async (action: ActionMetadata, checked: boolean) => {
			if (action.id === "enableNotifications") {
				await updateAutoApproveSettings({
					...autoApprovalSettings,
					version: (autoApprovalSettings.version ?? 1) + 1,
					enableNotifications: checked,
				})
			}
		},
		[autoApprovalSettings],
	)

	return {
		isChecked,
		updateAction,
		updateNotifications,
	}
}
