import { IDiracTool } from "../../interfaces/IDiracTool"
import { DiracToolSpec, DiracDefaultTool } from "../../../../../shared/tools"
import { SystemPromptContext } from "../../../../prompts/system-prompt/types"
import { IToolEnvironment } from "../../interfaces/IToolEnvironment"
import { CardStatus } from "../../../../../shared/ExtensionMessage"
import { SurfaceType } from "../../interfaces/SurfaceType"
import type { SkillMetadata } from "../../../../../shared/skills"
import { DiracIcon } from "@shared/icons"

export const list_skills_spec: DiracToolSpec<SystemPromptContext> = {
	id: DiracDefaultTool.LIST_SKILLS,
	name: "list_skills",
	description:
		"List all available skills and their descriptions. Use this to discover specialized capabilities when the initial list in the system prompt is truncated.",
	contextRequirements: (context: SystemPromptContext) => context.skills !== undefined && context.skills.length > 0,
}

export class ListSkillsTool implements IDiracTool {
	/**
	 * Returns the JSON schema for the list_skills tool.
	 */
	public spec(): DiracToolSpec {
		return list_skills_spec
	}

	/**
	 * Supported on all surfaces.
	 */
	public supportedSurfaces(): SurfaceType[] {
		return ["all"]
	}

	public async processCall(_args: any, env: IToolEnvironment): Promise<any> {
		const skills = env.config.taskState.availableSkills || []

		if (skills.length === 0) {
			if (!env.config.isSubagentExecution) {
				const card = await env.ui.createCard({
					icon: DiracIcon.SKILL,
					header: "List available skills",
					collapsed: true,
				})
				await card.update({
					status: CardStatus.SUCCESS,
					body: "No skills are currently available.",
				})
				await card.finalize(CardStatus.SUCCESS)
			}
			return "No skills are currently available."
		}

		const projectSkills = skills.filter((s: SkillMetadata) => s.source === "project")
		const builtinSkills = skills.filter((s: SkillMetadata) => s.source === "builtin")
		const globalSkills = skills.filter((s: SkillMetadata) => s.source === "global")
		const sortedSkills = [...projectSkills, ...builtinSkills, ...globalSkills]

		let response = "# AVAILABLE SKILLS\n\n"
		sortedSkills.forEach((skill) => {
			response += `- ${skill.name}: ${skill.description}\n`
		})
		response += "\nUse the 'use_skill' tool to activate a skill."

		if (!env.config.isSubagentExecution) {
			const card = await env.ui.createCard({
				icon: DiracIcon.SKILL,
				header: "List available skills",
				collapsed: true,
			})
			await card.appendBody(
				`Found ${skills.length} skills (${projectSkills.length} project, ${builtinSkills.length} built-in, ${globalSkills.length} global).\n`,
			)
			await card.update({
				header: "Listed available skills",
				status: CardStatus.SUCCESS,
				body: response,
			})
			await card.finalize(CardStatus.SUCCESS)
		}

		return response
	}
}
