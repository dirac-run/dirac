import type { EmptyRequest } from "@shared/proto/dirac/common"
import type { SandboxStatus } from "@shared/proto/dirac/state"
import { probeNativeSandbox } from "@integrations/terminal/sandbox/nativeSandbox"
import { buildSandboxStatus } from "@integrations/terminal/sandbox/status"
import type { Controller } from ".."

/** Read-only, explicitly requested execution-host discovery; never part of state publication. */
export async function getSandboxStatus(controller: Controller, _request: EmptyRequest): Promise<SandboxStatus> {
	return buildSandboxStatus(
		controller.stateManager.getSystemDefaultSettingsKey("sandboxSettings"),
		await probeNativeSandbox(),
		process.platform,
		process.arch,
	)
}
