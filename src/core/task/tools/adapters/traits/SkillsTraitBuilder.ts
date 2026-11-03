import { meetsHostCapabilityRequirement } from "@hosts/host-capabilities"
import { getOrDiscoverSkills, getSkillContent, listSupportingFiles } from "@core/context/instructions/user-instructions/skills"
import { filterSkillsByProviderCapabilities } from "@shared/skills"
import { isSkillAvailableToTaskProfile } from "../../../TaskExecutionProfile"
import type { ISkillsTrait } from "../../interfaces/IToolEnvironment"
import type { TaskConfig } from "../../types/TaskConfig"

// Builds the skills trait — discovery, content loading, and supporting file listing.
export function buildSkillsTrait(config: TaskConfig): ISkillsTrait {
	return {
		getAvailableSkills: async () => {
			const resolvedSkills = await getOrDiscoverSkills(config.cwd, config.taskState)
			const providerSkills = filterSkillsByProviderCapabilities(resolvedSkills, {
				native_web_search: config.supportsNativeWebSearch,
			})
			const globalToggles = config.globalSkillsToggles
			const localToggles = config.localSkillsToggles
			return providerSkills.filter(meetsHostCapabilityRequirement).filter((skill) => {
				if (config.allowedSkillNames && !config.allowedSkillNames.includes(skill.name)) return false
				if (!isSkillAvailableToTaskProfile(config.executionProfile, skill, config.isSubagentExecution)) return false
				if (config.yoloModeToggled && skill.interactiveOnly) return false
				if (skill.source === "builtin") return true
				const toggles = skill.source === "global" ? globalToggles : localToggles
				return toggles[skill.path] !== false
			})
		},
		getSkillContent: async (name, availableSkills) => (await getSkillContent(name, availableSkills)) || undefined,
		listSupportingFiles: async (path) => await listSupportingFiles(path),
	}
}
