import {
	type ResponseArguments,
	ResponseOperation,
	ResponseShapeError,
	validateResponseShape,
} from "@shared/responseTool"
import type { IToolEnvironment } from "../../interfaces/IToolEnvironment"

export class ResponseArgumentsError extends Error {
	constructor(message: string, env: IToolEnvironment) {
		super(message)
		env.orchestration.setTaskState("consecutiveMistakeCount", env.orchestration.getTaskState("consecutiveMistakeCount") + 1)
	}
}

export function validateResponseArguments(args: unknown, env: IToolEnvironment): ResponseArguments {
	let request: ResponseArguments
	try {
		request = validateResponseShape(args)
	} catch (error) {
		if (error instanceof ResponseShapeError) throw new ResponseArgumentsError(error.message, env)
		throw error
	}
	validateMode(request.operation, env)

	if (request.operation !== ResponseOperation.PROGRESS) env.orchestration.setTaskState("consecutiveMistakeCount", 0)
	return request
}

function validateMode(operation: ResponseOperation, env: IToolEnvironment): void {
	if (operation === ResponseOperation.PLAN && env.config.mode !== "plan") {
		throw new ResponseArgumentsError("The 'plan' response operation is available only in Plan Mode.", env)
	}
	if (operation === ResponseOperation.COMPLETE && env.config.mode !== "act") {
		throw new ResponseArgumentsError("The 'complete' response operation is available only in Act Mode.", env)
	}
}
