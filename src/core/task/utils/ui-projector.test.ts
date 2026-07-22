import "should"
import { TaskStatus, UIActionButtonType } from "@shared/ExtensionMessage"
import { TaskState } from "../TaskState"
import { projectUIActionState } from "./ui-projector"

describe("projectUIActionState", () => {
	it("shows only Start New Task for a completed task", () => {
		const state = new TaskState()
		state.status = TaskStatus.COMPLETED

		const uiState = projectUIActionState(state, [], 3)

		uiState.globalButtons.should.deepEqual([
			{
				label: "Start New Task",
				action: UIActionButtonType.NEW_TASK,
				primary: true,
			},
		])
		uiState.cardButtons.should.deepEqual([])
	})

	it("keeps Resume for a cancelled task", () => {
		const state = new TaskState()
		state.status = TaskStatus.CANCELLED

		const uiState = projectUIActionState(state, [], 3)

		uiState.globalButtons.should.deepEqual([
			{
				label: "Resume",
				action: UIActionButtonType.APPROVE,
				primary: true,
			},
		])
	})
})
