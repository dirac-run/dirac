import type { DiracToolSpec } from "@shared/tools"
import { goalToolJson, optionalNonEmptyString, requireArguments, requireGoalTrait } from "../../goal/GoalToolInput"
import { pendingGoalTaskCardBody, runGoalTaskActionCard } from "../../goal/GoalTaskActionCard"
import type { IDiracTool } from "../../interfaces/IDiracTool"
import type { IToolEnvironment } from "../../interfaces/IToolEnvironment"

export const verify_goal_spec: DiracToolSpec = {
	id: "verify_goal",
	name: "verify_goal",
	description: "Start an explicit asynchronous verification tasklet for the current Goal. Inspect and supervise its returned handle with tasklets; acceptance is not verification success.",
	parameters: [
		{
			name: "focus",
			required: false,
			instruction: "Optional non-empty focus for the verification assignment.",
			minLength: 1,
		},
	],
}

export class VerifyGoalTool implements IDiracTool {
	spec(): DiracToolSpec {
		return verify_goal_spec
	}

	supportedSurfaces() {
		return ["all" as const]
	}

	async processCall(input: unknown, environment: IToolEnvironment): Promise<string> {
		const args = requireArguments(input)
		const focus = optionalNonEmptyString(args, "focus")
		const goal = requireGoalTrait(environment)
		const tasklets = environment.orchestration.tasklets
		if (!tasklets) throw new Error("Goal verification requires root tasklet controls")
		const objective = await goal.getObjective()
		const children = tasklets.list()
		const prompt = [
			"Independently verify whether the current Goal objective is satisfied. Inspect the actual workspace and evidence; do not assume a child's completion or the coordinator's claim proves success. Report findings, remaining gaps and any limits on verification to the parent. Do not change the Goal lifecycle.",
			`<goal_objective revision="${objective.revision}">`,
			objective.markdown,
			"</goal_objective>",
			"<goal_tasklets>",
			...(children.length ? children.map((child) => `- ${child.id} | ${child.title} | ${child.outcome?.kind ?? "accepted"}`) : ["- none"]),
			"</goal_tasklets>",
			...(focus ? ["<verification_focus>", focus, "</verification_focus>"] : []),
		].join("\n\n")
		const focusText = focus ?? "Full Goal verification"
		const tasklet = await runGoalTaskActionCard(environment, {
			initial: {
				header: "Starting Goal verification",
				body: pendingGoalTaskCardBody("Verification", { label: "Focus", markdown: focusText }),
				rawInput: focus === undefined ? {} : { focus },
			},
			failureHeader: "Failed to start Goal verification",
			operation: () => tasklets.start({ title: "Goal verification", prompt, purpose: "goal_verification" }),
			completed: (record) => ({
				header: "Goal verification accepted",
				body: `**Tasklet:** \`${record.id}\`\n\n**Focus:** ${focusText}\n\nAcceptance is not verification success. Use tasklets to inspect its outcome.`,
				rawOutput: { ...record },
			}),
		})
		return goalToolJson(tasklet)
	}
}
