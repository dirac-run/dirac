import type { ISkillsTrait } from "../../interfaces/IToolEnvironment"
import type { TaskConfig } from "../../types/TaskConfig"
import { getOrDiscoverSkills, getSkillContent, listSupportingFiles } from "@core/context/instructions/user-instructions/skills"

// Builds the skills trait — discovery, content loading, and supporting file listing.
export function buildSkillsTrait(config: TaskConfig): ISkillsTrait {
	return {
		getAvailableSkills: async () => {
			const resolvedSkills = await getOrDiscoverSkills(config.cwd, config.taskState)
			const stateManager = config.services.stateManager
			const globalToggles = stateManager.getGlobalSettingsKey("globalSkillsToggles") ?? {}
			const localToggles = stateManager.getWorkspaceStateKey("localSkillsToggles") ?? {}
			return resolvedSkills.filter((skill) => {
				const toggles = skill.source === "global" ? globalToggles : localToggles
				return toggles[skill.path] !== false
			})
		},
		getSkillContent: async (name, availableSkills) => (await getSkillContent(name, availableSkills)) || undefined,
		listSupportingFiles: async (path) => await listSupportingFiles(path),
	}
}
