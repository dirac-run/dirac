import { strict as assert } from "node:assert"
import { setHostCapabilities } from "@hosts/host-capabilities"
import { afterEach, describe, it } from "mocha"
import sinon from "sinon"
import { createArchitectureBoardController } from "./createArchitectureBoardController"

describe("architecture board foreground ownership", () => {
	afterEach(() => setHostCapabilities(undefined))

	for (const executionProfile of ["standalone", "goal_coordinator", "goal_followup", "tasklet"]) {
		it(`checks ${executionProfile} ownership before accessing board storage`, async () => {
			setHostCapabilities({})
			const directory = sinon.stub().throws(new Error("Board storage must not be read"))
			const boards = createArchitectureBoardController({
				selected: () => ({ task: { taskId: "owner", executionProfile, cwd: "/workspace" } }) as any,
				// Even an incorrectly indexed private ID cannot grant a tasklet foreground authority.
				history: () => [{ id: "owner" }],
				directory,
				readConversation: async () => [],
			})
			try {
				await assert.rejects(
					boards.open({ taskId: "owner", name: "diagram", mode: "latest" }),
					executionProfile === "tasklet" ? /private tasklets/ : /viewer is unavailable/,
				)
				sinon.assert.notCalled(directory)
			} finally {
				boards.dispose()
			}
		})
	}
})
