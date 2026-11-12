import type { Mode } from "./storage/types"

export function modeSwitchNotice(mode: Mode): string {
	return `The user switched to ${mode.toUpperCase()} MODE. You are now in ${mode === "plan" ? "Plan" : "Act"} mode.`
}
