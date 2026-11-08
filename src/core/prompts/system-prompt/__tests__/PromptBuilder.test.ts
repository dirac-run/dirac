import { expect } from "chai"
import { PromptBuilder } from "../registry/PromptBuilder"
import type { SystemPromptContext } from "../types"
import { mockProviderInfo } from "./test-helpers"

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
				}).build()
				expect(prompt).to.include("TASKLET DELEGATION")
				expect(prompt).to.include("The `subagents` tool starts a batch of assignments asynchronously")
				expect(prompt).not.to.include("named-agent spawn tools")
				expect(prompt).to.include("startup acceptance, not assignment success or completion")
				expect(prompt).to.include("startup failures are reported separately")
				expect(prompt).to.include("Later results, progress, and requests arrive through parent communication")
				expect(prompt).to.include("`tasklets` `list` for compact inventory and `inspect` views")
				expect(prompt).to.include("`tasklets` with `sleep` to wait for events rather than repeatedly polling")
				expect(prompt).to.include("let active tasklets finish or explicitly interrupt them")
				expect(prompt).to.include("Child execution has no automatic deadline")
				expect(prompt).to.include("explicit `tasklets` `resume`")
				expect(prompt).to.include("only limits the parent's wait")
				expect(prompt).not.to.include("configured timeout")
				expect(prompt).not.to.include("A deadline interrupts the tasklet")
			})
		}

		it("does not inject root guidance into tasklet prompts", async () => {
			const prompt = await new PromptBuilder({
				...mockContext,
				executionProfile: "tasklet",
				subagentsEnabled: true,
			}).build()
			expect(prompt).to.not.include("TASKLET DELEGATION")
			expect(prompt).to.not.include("`tasklets`")
		})

		for (const executionProfile of ["standalone", "goal_coordinator", "goal_followup"] as const) {
			it(`does not advertise spawning for ${executionProfile} when delegation is disabled or unspecified`, async () => {
				for (const subagentsEnabled of [false, undefined]) {
					const prompt = await new PromptBuilder({ ...mockContext, executionProfile, subagentsEnabled }).build()
					expect(prompt).to.not.include("TASKLET DELEGATION")
				}
			})
		}

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
