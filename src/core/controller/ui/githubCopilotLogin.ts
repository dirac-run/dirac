import { Empty, EmptyRequest } from "@shared/proto/dirac/common"
import type { Controller } from "../index"

/**
 * Initiates GitHub Copilot login flow
 * @param controller The controller instance
 * @param _request The empty request
 * @returns Empty response
 */
export async function githubCopilotLogin(controller: Controller, _request: EmptyRequest): Promise<Empty> {
	await controller.completeGithubLogin()
	return Empty.create({})
}
