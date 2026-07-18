import { Empty, StringRequest } from "@shared/proto/dirac/common"
import { activateModelProviderPreset as activatePreset } from "@core/models/modelProviderPresets"
import type { Controller } from ".."

export async function activateModelProviderPreset(controller: Controller, request: StringRequest): Promise<Empty> {
	if (!request.value) throw new Error("Model/provider preset ID is required")
	await activatePreset(controller, request.value)
	return Empty.create()
}
