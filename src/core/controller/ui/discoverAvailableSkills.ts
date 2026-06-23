import { getOrDiscoverSkills } from "@core/context/instructions/user-instructions/skills"
import type { StateManager } from "@core/storage/StateManager"

/** Discovers skills for the cwd and filters by global/local toggles. */
export async function discoverAvailableSkills(stateManager: StateManager, cwd: string, taskState: any) {
	const globalSkillsToggles = stateManager.getGlobalSettingsKey("globalSkillsToggles")
	const localSkillsToggles = stateManager.getWorkspaceStateKey("localSkillsToggles")
	const discoveredSkills = await getOrDiscoverSkills(cwd, taskState || {})
	return discoveredSkills.filter((skill) => {
		const toggles = skill.source === "global" ? globalSkillsToggles : localSkillsToggles
		return toggles[skill.path] !== false
	})
}
