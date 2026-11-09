import { expect } from "chai"
import { PromptBuilder } from "../registry/PromptBuilder"
import type { SystemPromptContext } from "../types"
import { mockProviderInfo } from "./test-helpers"
import { taskProfileSystemInstructions } from "@core/task/TaskExecutionProfile"

describe("PromptBuilder", () => {
	const mockContext: SystemPromptContext = {
		cwd: "/test/project",
		ide: "TestIde",
		supportsBrowserUse: true,
		browserSettings: {
			viewport: {
				width: 1280,
				height: 720,
			},
		},
		isTesting: true,
		providerInfo: mockProviderInfo,
		yoloModeToggled: false,
	}

	describe("tasklet parent guidance", () => {
		for (const executionProfile of ["standalone", "goal_coordinator", "goal_followup"] as const) {
			it(`describes asynchronous delegation, inspection, voluntary sleep and explicit timeout resumption for ${executionProfile}`, async () => {
				const prompt = await new PromptBuilder({
					...mockContext,
					executionProfile,
					subagentsEnabled: true,
					profileInstructions: taskProfileSystemInstructions(executionProfile, true),
				}).build()
				expect(prompt).to.match(/^You are Dirac, the root AI agent/)
				expect(prompt).to.include("You have no parent")
				expect(prompt).to.include("Your stable ID is Dirac")
				expect(prompt.match(/operation=create/g)).to.have.lengthOf(1)
				expect(prompt).to.include("You own supervision, integration of delegated work, and the final user outcome")
				expect(prompt).to.include("Use `respond` to address the user")
				expect(prompt).to.include("Tasks have two modes")
				expect(prompt).to.include("`list_agents`")
				expect(prompt).to.include("TASKLET DELEGATION")
				expect(prompt).to.include("The `subagents` tool with `operation=create` starts a batch of assignments asynchronously")
				expect(prompt).not.to.include("named-agent spawn tools")
				expect(prompt).to.include("startup acceptance, not assignment success or completion")
				expect(prompt).to.include("startup failures are reported separately")
				expect(prompt).to.include("Later results, progress, and requests arrive through parent communication")
				expect(prompt).to.include("`subagents` `list` for compact inventory and `inspect` views")
				expect(prompt).to.include("`subagents` with `sleep` to wait for events rather than repeatedly polling")
				expect(prompt).to.include("let active tasklets finish or explicitly interrupt them")
				expect(prompt).to.include("Child execution has no automatic deadline")
				expect(prompt).to.include("explicit `subagents` `resume`")
				expect(prompt).to.include("only limits the parent's wait")
				expect(prompt).not.to.include("configured timeout")
				expect(prompt).not.to.include("A deadline interrupts the tasklet")
			})
		}

		it("does not inject root guidance into tasklet prompts", async () => {
			const prompt = await new PromptBuilder({
				...mockContext,
				executionProfile: "tasklet",
				taskId: "Feynman2",
				subagentsEnabled: true,
				profileInstructions: taskProfileSystemInstructions("tasklet", true),
			}).build()
			expect(prompt).to.match(/^Your stable ID is Feynman2; your parent's stable ID is Dirac\./)
			expect(prompt).to.include("You are an assigned worker")
			expect(prompt).to.include("assigned worker for Dirac")
			expect(prompt).to.include("Use `respond` to report to Dirac")
			expect(prompt).to.include("always execute in Act mode")
			expect(prompt).to.include("does not grant authority beyond Dirac's current restrictions")
			expect(prompt).not.to.match(/user-facing communication|Tasks have two modes|notified every time the mode switches|do not address the end user|user timeline/)
			expect(prompt).not.to.include("`plan` for Plan-mode")
			expect(prompt).not.to.include("You are Dirac")
			expect(prompt).to.include("`list_agents`")
			expect(prompt).to.not.include("TASKLET DELEGATION")
			expect(prompt).to.not.include("`subagents`")
		})

		for (const executionProfile of ["standalone", "goal_coordinator", "goal_followup"] as const) {
			it(`does not advertise spawning for ${executionProfile} when delegation is disabled or unspecified`, async () => {
				for (const subagentsEnabled of [false, undefined]) {
					const prompt = await new PromptBuilder({
						...mockContext,
						executionProfile,
						subagentsEnabled,
						profileInstructions: taskProfileSystemInstructions(executionProfile, subagentsEnabled),
					}).build()
					expect(prompt).to.match(/^You are Dirac, an AI agent for software-engineering tasks\.\n/)
					expect(prompt).to.not.match(/TASKLET DELEGATION|parent|subagents|tasklets?|child|list_agents|send_message/i)
					expect(prompt).to.not.include("# Agent identity")
					expect(prompt).to.include("Use `respond` to address the user")
					expect(prompt).to.include("Tasks have two modes")
				}
			})
		}

		it("keeps a child's stable identity when delegation is disabled", async () => {
			const prompt = await new PromptBuilder({
				...mockContext,
				executionProfile: "tasklet",
				taskId: "Bohr",
				subagentsEnabled: false,
			}).build()
			expect(prompt).to.match(/^Your stable ID is Bohr; your parent's stable ID is Dirac\./)
			expect(prompt).not.to.include("You are Dirac")
		})

		it("does not infer parent capability from the delegation setting without a profile", async () => {
			const prompt = await new PromptBuilder({ ...mockContext, subagentsEnabled: true }).build()
			expect(prompt).to.not.include("TASKLET DELEGATION")
		})
	})

	describe("postProcess", () => {
		it("should clean up multiple empty lines", async () => {
			const builder = new PromptBuilder(mockContext)
			const result = await builder.build()

			// Should not have more than 2 consecutive newlines
			expect(result).to.not.match(/\n\s*\n\s*\n/)
		})
	})
})
