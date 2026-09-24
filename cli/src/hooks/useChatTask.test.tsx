import { Text } from "ink"
import { render } from "ink-testing-library"
// biome-ignore lint/correctness/noUnusedImports: Vitest transforms this test with the classic JSX runtime.
import React from "react"
import { describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
	showTaskWithId: vi.fn(),
}))

vi.mock("@/core/controller/task/showTaskWithId", () => ({
	showTaskWithId: mocks.showTaskWithId,
}))

vi.mock("../utils/shutdown", () => ({
	shutdownEvent: {
		event: () => ({ dispose: vi.fn() }),
	},
}))

vi.mock("@/services/telemetry", () => ({
	telemetryService: { captureHostEvent: vi.fn() },
}))

vi.mock("@/shared/services/Session", () => ({
	Session: { get: () => ({ getStats: () => ({}) }) },
}))

vi.mock("../utils/display", () => ({
	setTerminalTitle: vi.fn(),
}))

import { useChatTask } from "./useChatTask"

function Harness({ controller, onError }: { controller: unknown; onError: (context: string, error: unknown) => void }) {
	useChatTask({
		ctrl: controller,
		taskId: "target-task",
		initialPrompt: "follow up",
		resetComposerInput: vi.fn(),
		onInteractionError: onError,
		clearState: vi.fn(),
		setTaskSwitchKey: vi.fn(),
	})
	return <Text>ready</Text>
}

describe("useChatTask startup", () => {
	it("loads the requested task before submitting an initial follow-up", async () => {
		const previousSubmit = vi.fn()
		const targetSubmit = vi.fn().mockResolvedValue(undefined)
		const targetTask = { taskId: "target-task", submitCardResponse: targetSubmit }
		const controller = {
			task: { taskId: "previous-task", submitCardResponse: previousSubmit },
			initTask: vi.fn(),
		}
		mocks.showTaskWithId.mockImplementationOnce(async (receivedController) => {
			receivedController.task = targetTask
		})
		const onError = vi.fn()

		const app = render(<Harness controller={controller} onError={onError} />)
		await vi.waitFor(() => expect(targetSubmit).toHaveBeenCalledOnce())

		expect(mocks.showTaskWithId).toHaveBeenCalledOnce()
		expect(previousSubmit).not.toHaveBeenCalled()
		expect(controller.initTask).not.toHaveBeenCalled()
		expect(onError).not.toHaveBeenCalled()
		app.unmount()
	})
})
