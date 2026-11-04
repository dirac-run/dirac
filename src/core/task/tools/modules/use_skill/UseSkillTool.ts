import { IDiracTool } from "../../interfaces/IDiracTool"
import { IToolEnvironment } from "../../interfaces/IToolEnvironment"
import { DiracToolSpec, DiracDefaultTool } from "@shared/tools"
import { CardStatus } from "../../../../../shared/ExtensionMessage"
import { DiracIcon } from "@shared/icons"
import { SurfaceType } from "../../interfaces/SurfaceType"
import { ToolExecutionDeadline, ToolTimeoutError } from "../../runtime/ToolExecutionDeadline"
import { presentToolTimeout } from "../../runtime/ToolTimeoutPresentation"

export const use_skill_spec: DiracToolSpec = {
	id: DiracDefaultTool.USE_SKILL,
	name: "use_skill",
	description:
		"Load and activate a skill by name. Skills provide specialized instructions for specific tasks. Reusing an active skill reloads its instructions without duplicating activation.",
	parameters: [
		{
			name: "skill_name",
			required: true,
			instruction: "The name of the skill to activate (must match exactly one of the available skill names)",
		},
	],
}

export class UseSkillTool implements IDiracTool {
	spec(): DiracToolSpec {
		return use_skill_spec
	}

	supportedSurfaces(): SurfaceType[] {
		return ["all"]
	}

	async processCall(args: { skill_name: string }, env: IToolEnvironment): Promise<string> {
		const { skill_name } = args

		if (!skill_name) {
			throw new Error("Missing required parameter 'skill_name'. Please provide the name of the skill to activate.")
		}
		const deadline = new ToolExecutionDeadline(this.spec().name)

		const card = await env.ui.createCard({
			icon: DiracIcon.SKILL,
			header: `Activate skill: ${skill_name}`,
			collapsed: true,
		})

		try {
			const availableSkills = await deadline.run("discovering available skills", async () =>
				await env.skills.getAvailableSkills())
			const skillContent = await deadline.run(`loading skill ${skill_name}`, async () =>
				await env.skills.getSkillContent(skill_name, availableSkills))

			if (!skillContent) {
				const availableNames = availableSkills.map((s) => s.name).join(", ")
				const errorMsg = `Error: Skill "${skill_name}" not found. Available skills: ${availableNames || "none"}`
				await card.update({ status: CardStatus.ERROR, body: errorMsg })
				await card.finalize(CardStatus.ERROR)
				return errorMsg
			}
			const { docs, scripts } = await deadline.run(`listing support files for ${skill_name}`, async () =>
				await env.skills.listSupportingFiles(skillContent.path))

			const activeSkillIds = env.orchestration.getTaskState("activeSkillIds")
			const alreadyActive = activeSkillIds.includes(skillContent.name)
			if (!alreadyActive) {
				await env.orchestration.activateSkill(skillContent.name)
			}

			const globalCount = availableSkills.filter((skill) => skill.source === "global").length
			const projectCount = availableSkills.filter((skill) => skill.source === "project").length

			env.telemetry.captureCustomMetadata({
				skillName: skill_name,
				skillSource: skillContent.source,
				skillsAvailableGlobal: globalCount,
				skillsAvailableProject: projectCount,
			})

			const activationState = alreadyActive ? "already active; instructions reloaded" : "now active"
			let activationMessage = `# Skill "${skillContent.name}" is ${activationState}\n\n${skillContent.instructions}\n\n---\n`
			activationMessage += `IMPORTANT: The skill instructions are loaded. Follow them to continue the task.\n`

			const skillDir = skillContent.path.replace(/SKILL\.md$/, "")
			if (docs.length > 0 || scripts.length > 0) {
				activationMessage += `\nYou may access supporting files in the skill directory: ${skillDir}\n`
				if (docs.length > 0) {
					activationMessage += `\nDocumentation available:\n${docs.map((f) => `- ${skillDir}docs/${f}`).join("\n")}\n`
				}
				if (scripts.length > 0) {
					activationMessage += `\nScripts available (run via execute_command):\n${scripts.map((f) => `- ${skillDir}scripts/${f}`).join("\n")}\n`
				}
			} else {
				activationMessage += `\nYou may access other files in the skill directory at: ${skillDir}`
			}

			await card.update({
				header: alreadyActive ? `Reloaded active skill: ${skill_name}` : `Activated skill: ${skill_name}`,
				status: CardStatus.SUCCESS,
				body: `✓ Skill source: ${skillContent.source}\nDirectory: ${skillDir}`,
			})
			await card.finalize(CardStatus.SUCCESS)
			return activationMessage
		} catch (error: any) {
			if (error instanceof ToolTimeoutError) {
				return await presentToolTimeout(env, error, [card])
			}
			await card.update({ status: CardStatus.ERROR, body: `✕ ${error.message}` })
			await card.finalize(CardStatus.ERROR)
			throw error
		}
	}
}
