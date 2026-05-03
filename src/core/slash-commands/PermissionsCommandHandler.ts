import { CommandPermissionController } from "../permissions/CommandPermissionController"
import { ToolPermissionRule } from "../permissions/types"

export async function handlePermissionsCommand(
	text: string,
	permissionController: CommandPermissionController
): Promise<{ processedText: string; success: boolean }> {
	// Pattern: /permissions (allow|deny) <tool> <pattern>
	// Or: /permissions (allow|deny) <tool>
	const match = text.match(/\/permissions\s+(allow|deny)\s+([^\s]+)(?:\s+(.+))?/)

	if (!match) {
		return {
			processedText:
				"Invalid /permissions command. Usage: /permissions <allow|deny> <tool> [pattern]",
			success: false,
		}
	}

	const action = match[1] as "allow" | "deny"
	const tool = match[2]
	const pattern = match[3]?.trim()

	const newRule: ToolPermissionRule = {
		tool,
		pattern,
		action,
	}

	try {
		// Load current config
		// Note: We need a way to get the current config from the controller
		// For now, I'll assume we can just save a new rule.
		// Actually, I should add a method to add a rule to the controller.
		await permissionController.addRule(newRule)

		const patternDesc = pattern ? ` for pattern "${pattern}"` : ""
		return {
			processedText: `Permission updated: ${action} ${tool}${patternDesc}.`,
			success: true,
		}
	} catch (error) {
		return {
			processedText: `Failed to update permissions: ${error instanceof Error ? error.message : String(error)}`,
			success: false,
		}
	}
}
