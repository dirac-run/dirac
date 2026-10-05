import { Empty } from "@shared/proto/dirac/common"
import { SteerTaskRequest } from "@shared/proto/dirac/task"
import { Controller } from ".."

export async function steerTask(controller: Controller, request: SteerTaskRequest): Promise<Empty> {
	if (controller.selectedGoalId) {
		await controller.sendGoalMessage(controller.selectedGoalId, request.text)
		return Empty.create()
	}
	const task = controller.task
	if (!task) throw new Error("No active task to steer")
	if (!task.canAcceptSteeringMessage()) throw new Error(`Task cannot accept steering while ${task.stateView.status}`)

	await task.enqueueSteeringMessage(request.text)
	return Empty.create()
}
