import { HostProvider } from "@/hosts/host-provider"
import { ShowMessageType } from "@/shared/proto/host/window"
import { Controller } from ".."

/** Show terminal profile change notifications for closed and busy terminals */
export function notifyTerminalProfileChange(closedCount: number, busyTerminalsCount: number): void {
	if (closedCount > 0) {
		HostProvider.window.showMessage({
			type: ShowMessageType.INFORMATION,
			message: `Closed ${closedCount} ${closedCount === 1 ? "terminal" : "terminals"} with different profile.`,
		})
	}
	if (busyTerminalsCount > 0) {
		const message = `${busyTerminalsCount} busy ${busyTerminalsCount === 1 ? "terminal has" : "terminals have"} a different profile. Close ${busyTerminalsCount === 1 ? "it" : "them"} to use the new profile for all commands.`
		HostProvider.window.showMessage({ type: ShowMessageType.WARNING, message })
	}
}

/** Set default terminal profile and sync active task's terminal manager */
export function setDefaultTerminalProfile(controller: Controller, profileId: string): void {
	controller.stateManager.setGlobalState("defaultTerminalProfile", profileId)
	if (!controller.task) return
	if (!controller.task.terminalManager)
		throw new Error("Cannot update terminal profile: Terminal manager missing from active task")
	const result = controller.task.terminalManager.setDefaultTerminalProfile(profileId)
	notifyTerminalProfileChange(result.closedCount, result.busyTerminals?.length ?? 0)
}
