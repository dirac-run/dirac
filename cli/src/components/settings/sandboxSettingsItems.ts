import { DEFAULT_SANDBOX_SETTINGS, getSandboxProfiles, type SandboxSettings } from "@shared/SandboxSettings"
import type { SandboxStatus } from "@shared/proto/dirac/state"
import { SETTINGS_HELP, sandboxHostLimitations } from "@shared/settings-presentation"
import { type ListItem, SettingsItemType } from "./types"

export function createSandboxSettingsItems(
	settings: SandboxSettings = DEFAULT_SANDBOX_SETTINGS,
	status?: SandboxStatus,
	statusError?: string,
	advanced = false,
): ListItem[] {
	const note = (key: string, value: string): ListItem => ({ key, label: "", value, type: SettingsItemType.READONLY })
	const action = (key: string, label: string): ListItem => ({ key, label, value: "", type: SettingsItemType.ACTION })
	const profiles = getSandboxProfiles(settings)
	const critical: ListItem[] = [
		...(status?.error
			? [
					{
						...note("sandboxError", `${status.errorCategory ? `${status.errorCategory}: ` : ""}${status.error}`),
						persistentHelp: status.remediation || undefined,
						alwaysShowHelp: true,
						helpTone: "error" as const,
					},
				]
			: []),
		...(!status?.error && (status?.effectiveState === "blocked" || status?.effectiveState === "configuration-error")
			? [
					{
						...note("sandboxBlocked", "Commands are blocked until sandbox setup or settings are repaired."),
						persistentHelp: status.remediation || undefined,
						alwaysShowHelp: true,
						helpTone: "error" as const,
					},
				]
			: []),
		...(statusError
			? [
					{
						...note("sandboxStatus", `Status unavailable: ${statusError}. Availability is unknown.`),
						helpTone: "error" as const,
					},
				]
			: []),
		...(status?.effectiveState === "configuration-error"
			? [action("sandboxReset", "Reset sandbox settings (disabled)")]
			: []),
		...(status?.error ||
		statusError ||
		status?.effectiveState === "configuration-error" ||
		status?.effectiveState === "blocked"
			? [action("sandboxRefresh", "Refresh host status")]
			: []),
	]
	const enabled: ListItem = {
		key: "sandboxEnabled",
		label: "Sandbox commands",
		value: settings.enabled,
		type: SettingsItemType.CHECKBOX,
		expandedHelp: SETTINGS_HELP.sandboxEnabled,
	}
	if (!settings.enabled) return [enabled, note("sandboxOff", "Sandbox is disabled."), ...critical]
	return [
		enabled,
		...critical,
		...(
			[
				["mainAgentProfileId", "Main agent"],
				["subagentProfileId", "Subagents"],
			] as const
		).map(
			([key, label]): ListItem => ({
				key: `sandbox:${key}`,
				label,
				type: SettingsItemType.CYCLE,
				value:
					settings[key] === "default"
						? "Default (unrestricted)"
						: (profiles.find((profile) => profile.id === settings[key])?.name ?? settings[key]),
				cycleOptions: profiles.map((profile) => profile.id),
			}),
		),
		{ key: "sandboxProfiles", label: "Profiles", value: "", type: SettingsItemType.HEADER },
		...profiles.flatMap((profile): ListItem[] =>
			profile.id === "default"
				? [note("sandboxBuiltin:default", "Default (unrestricted)")]
				: settings.profiles.some((custom) => custom.id === profile.id)
					? [
							action(`sandboxEdit:${profile.id}`, `Edit ${profile.name}`),
							action(`sandboxDuplicate:${profile.id}`, `Duplicate ${profile.name}`),
						]
					: [action(`sandboxCustomize:${profile.id}`, `Customize ${profile.name}…`)],
		),
		action("sandboxCreate", "Create profile…"),
		action("sandboxAdvanced", advanced ? "▾ Advanced" : "▸ Advanced"),
		...(advanced
			? [
					{
						key: "sandboxFallback",
						label: "Allow unsandboxed fallback",
						value: settings.allowUnsandboxedFallback,
						type: SettingsItemType.CHECKBOX,
						persistentHelp: settings.allowUnsandboxedFallback
							? "Warning: eligible setup failures can execute commands without sandbox restrictions."
							: undefined,
						expandedHelp: SETTINGS_HELP.sandboxFallback,
						helpTone: "warning" as const,
					},
					...(status
						? [
								note(
									"sandboxHost",
									`${status.hostPlatform} · ${status.available ? "Backend available" : "Backend unavailable"} · ${status.effectiveState}`,
								),
								...(!status.error && status.remediation ? [note("sandboxRemediation", status.remediation)] : []),
							]
						: !statusError
							? [note("sandboxStatus", "Checking execution host…")]
							: []),
					...(!critical.some((item) => item.key === "sandboxRefresh")
						? [action("sandboxRefresh", "Refresh host status")]
						: []),
					{
						...action("sandboxDetails", "Technical details"),
						expandedHelp: [
							SETTINGS_HELP.sandboxCoverage,
							SETTINGS_HELP.sandboxDefault,
							SETTINGS_HELP.sandboxCustom,
							SETTINGS_HELP.sandboxFallback,
							SETTINGS_HELP.sandboxPaths,
							...(status
								? [
										`Execution host: ${status.hostPlatform}; backend: ${status.backend || "none"}`,
										...sandboxHostLimitations(status.limitations).map(
											(limitation) => `Limitation: ${limitation}`,
										),
									]
								: []),
						].join("\n\n"),
					},
				]
			: []),
	]
}
