import { EmptyRequest } from "@shared/proto/dirac/common"
import type { SandboxStatus } from "@shared/proto/dirac/state"
import {
	type CustomSandboxProfile,
	DEFAULT_SANDBOX_SETTINGS,
	getSandboxProfiles,
	type SandboxSettings,
	validateSandboxSettings,
} from "@shared/SandboxSettings"
import { SETTINGS_HELP, sandboxHostLimitations, sandboxProfileSummary } from "@shared/settings-presentation"
import { VSCodeCheckbox } from "@vscode/webview-ui-toolkit/react"
import { useCallback, useEffect, useRef, useState } from "react"
import { useSettingsStore } from "@/features/settings/store/settingsStore"
import { StateServiceClient } from "@/shared/api/grpc-client"
import { Button } from "@/shared/ui/button"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/shared/ui/select"
import Section from "../Section"
import { persistSetting } from "../utils/settingsHandlers"
import SandboxProfileEditor from "./SandboxProfileEditor"

export default function SandboxSettingsSection({
	renderSectionHeader,
}: {
	renderSectionHeader: (id: string) => JSX.Element | null
}) {
	const sandboxSettings = useSettingsStore((state) => state.sandboxSettings)
	const [status, setStatus] = useState<SandboxStatus>()
	const [statusError, setStatusError] = useState<string>()
	const [saveError, setSaveError] = useState<string>()
	const [loading, setLoading] = useState(false)
	const [saving, setSaving] = useState(false)
	const [managing, setManaging] = useState(false)
	const [editor, setEditor] = useState<{ profile?: CustomSandboxProfile; duplicate?: boolean }>()
	const profiles = getSandboxProfiles(sandboxSettings)
	const limitations = sandboxHostLimitations(status?.limitations ?? [])
	const generation = useRef(0)
	const refresh = useCallback(async () => {
		const request = ++generation.current
		setLoading(true)
		setStatus(undefined)
		setStatusError(undefined)
		try {
			const next = await StateServiceClient.getSandboxStatus(EmptyRequest.create({}))
			if (request === generation.current) setStatus(next)
		} catch (error) {
			if (request === generation.current) setStatusError(String(error))
		} finally {
			if (request === generation.current) setLoading(false)
		}
	}, [])
	useEffect(() => {
		void refresh()
		return () => {
			generation.current++
		}
	}, [refresh])

	const save = async (patch: Partial<SandboxSettings>, reset = false) => {
		setSaving(true)
		setSaveError(undefined)
		try {
			await persistSetting(
				"sandboxSettings",
				validateSandboxSettings({ ...(reset ? DEFAULT_SANDBOX_SETTINGS : sandboxSettings), ...patch }),
			)
			await refresh()
			return true
		} catch (error) {
			setSaveError(String(error))
			return new Error(String(error))
		} finally {
			setSaving(false)
		}
	}
	if (editor)
		return (
			<SandboxProfileEditor
				{...editor}
				onCancel={() => setEditor(undefined)}
				onSave={async (profile) => {
					const next = [...sandboxSettings.profiles.filter((entry) => entry.id !== profile.id), profile]
					const result = await save({ profiles: next })
					if (result !== true) throw result
					setEditor(undefined)
				}}
			/>
		)
	return (
		<div>
			{renderSectionHeader("sandbox")}
			<Section className="py-4">
				<div className="flex min-w-0 max-w-2xl flex-col gap-5 wrap-anywhere" id="sandbox-settings">
					<div className="flex flex-col gap-2">
						<VSCodeCheckbox
							checked={sandboxSettings.enabled}
							disabled={saving}
							onChange={(event) => {
								const checked = (event.target as HTMLInputElement).checked
								// Toolkit property updates emit change too, before React replaces the old listener.
								if (checked !== useSettingsStore.getState().sandboxSettings.enabled)
									void save({ enabled: checked })
							}}>
							Sandbox commands
						</VSCodeCheckbox>
						<p className="m-0 text-xs leading-relaxed text-description">
							{sandboxSettings.enabled
								? "Apply sandbox profiles to future command launches."
								: "Sandbox is disabled."}
						</p>
					</div>
					{saveError && (
						<p className="m-0 text-error" role="alert">
							Could not save sandbox settings: {saveError}
						</p>
					)}
					{statusError && (
						<div className="flex flex-col items-start gap-2" role="alert">
							<p className="m-0 text-error">Status unavailable: {statusError}</p>
							<Button disabled={loading} onClick={() => void refresh()} size="sm" variant="secondary">
								Retry status
							</Button>
						</div>
					)}
					{status?.error && (
						<div className="flex flex-col gap-2 border-l-2 border-error pl-3 text-xs leading-relaxed" role="alert">
							<p className="m-0 text-error">{status.error}</p>
							{status.remediation && <p className="m-0 text-description">{status.remediation}</p>}
							{sandboxSettings.enabled &&
								limitations.map((limitation) => (
									<p className="m-0 text-description" key={limitation}>
										{limitation}
									</p>
								))}
						</div>
					)}
					{status?.effectiveState === "configuration-error" && (
						<div>
							<Button
								aria-label="Reset sandbox settings to Default (Off)"
								disabled={saving}
								onClick={() => void save(DEFAULT_SANDBOX_SETTINGS, true)}
								size="sm">
								Reset to Default (Off)
							</Button>
						</div>
					)}
					{sandboxSettings.enabled && (
						<>
							<section
								aria-labelledby="sandbox-agent-profiles"
								className="flex min-w-0 flex-col gap-3 border-t border-(--vscode-panel-border) pt-4">
								<h3 className="m-0 text-sm font-medium" id="sandbox-agent-profiles">
									Agent profiles
								</h3>
								<div className="grid grid-cols-[repeat(auto-fit,minmax(min(100%,220px),1fr))] gap-4">
									{(
										[
											["mainAgentProfileId", "Main-agent profile"],
											["subagentProfileId", "Subagent profile"],
										] as const
									).map(([key, label]) => (
										<div className="flex min-w-0 flex-col gap-2" key={key}>
											<label className="text-xs text-description" htmlFor={`sandbox-${key}`}>
												{label}
											</label>
											<Select
												disabled={saving}
												onValueChange={(value) => void save({ [key]: value })}
												value={sandboxSettings[key]}>
												<SelectTrigger className="w-full text-xs" id={`sandbox-${key}`} size="sm">
													<SelectValue />
												</SelectTrigger>
												<SelectContent align="start">
													{profiles.map((profile) => (
														<SelectItem key={profile.id} value={profile.id}>
															{profile.id === "default" ? "Default (unrestricted)" : profile.name}
														</SelectItem>
													))}
												</SelectContent>
											</Select>
										</div>
									))}
								</div>
								{[sandboxSettings.mainAgentProfileId, sandboxSettings.subagentProfileId].includes("default") && (
									<p className="m-0 text-xs leading-relaxed text-description">{SETTINGS_HELP.sandboxDefault}</p>
								)}
							</section>
							<section
								aria-labelledby="sandbox-saved-profiles"
								className="flex min-w-0 flex-col gap-3 border-t border-(--vscode-panel-border) pt-4">
								<div className="flex flex-wrap items-center justify-between gap-3">
									<h3 className="m-0 text-sm font-medium" id="sandbox-saved-profiles">
										Saved profiles
									</h3>
									<div className="flex flex-wrap gap-2">
										<Button disabled={saving} onClick={() => setEditor({})} size="sm">
											New
										</Button>
										<Button
											aria-controls="sandbox-profile-list"
											aria-expanded={managing}
											disabled={saving}
											onClick={() => setManaging(!managing)}
											size="sm"
											variant="secondary">
											Manage
										</Button>
									</div>
								</div>
								<p className="m-0 text-xs leading-relaxed text-description">
									Create or customize profiles, then assign them to an agent above.
								</p>
								{managing && (
									<ul
										className="m-0 list-none divide-y divide-(--vscode-panel-border) rounded-sm border border-(--vscode-panel-border) px-3"
										id="sandbox-profile-list">
										{profiles.map((profile) => (
											<li
												className="flex flex-wrap items-center justify-between gap-3 py-3"
												key={profile.id}>
												<div className="flex min-w-0 flex-1 basis-48 flex-col gap-1">
													<span className="text-sm font-medium">
														{profile.id === "default" ? "Default (unrestricted)" : profile.name}
													</span>
													<p className="m-0 text-xs leading-relaxed text-description">
														{"filesystem" in profile
															? sandboxProfileSummary(profile)
															: "Built-in · No restrictions"}
													</p>
												</div>
												{"filesystem" in profile && (
													<div className="flex flex-wrap gap-2">
														{sandboxSettings.profiles.some((entry) => entry.id === profile.id) ? (
															<>
																<Button
																	aria-label={`Edit ${profile.name}`}
																	disabled={saving}
																	onClick={() => setEditor({ profile })}
																	size="sm"
																	variant="secondary">
																	Edit
																</Button>
																<Button
																	aria-label={`Duplicate ${profile.name}`}
																	disabled={saving}
																	onClick={() => setEditor({ profile, duplicate: true })}
																	size="sm"
																	variant="secondary">
																	Duplicate
																</Button>
															</>
														) : (
															<Button
																aria-label={`Customize ${profile.name}`}
																disabled={saving}
																onClick={() => setEditor({ profile, duplicate: true })}
																size="sm"
																variant="secondary">
																Customize
															</Button>
														)}
													</div>
												)}
											</li>
										))}
									</ul>
								)}
							</section>
							{(status?.effectiveState === "fallback" || sandboxSettings.allowUnsandboxedFallback) && (
								<p
									className="m-0 border-l-2 border-(--vscode-editorWarning-foreground) pl-3 text-xs leading-relaxed"
									role="alert">
									{status?.effectiveState === "fallback"
										? "Commands may run unsandboxed using your authorized fallback."
										: "Unsandboxed fallback is allowed for setup failures."}
								</p>
							)}
							<details className="border-t border-(--vscode-panel-border) pt-4">
								<summary className="cursor-pointer text-sm font-medium">Details and advanced settings</summary>
								<div className="flex min-w-0 flex-col gap-4 pt-4">
									<div className="flex flex-col gap-2">
										<VSCodeCheckbox
											checked={sandboxSettings.allowUnsandboxedFallback}
											disabled={saving}
											onChange={(event) => {
												const checked = (event.target as HTMLInputElement).checked
												if (
													checked !==
													useSettingsStore.getState().sandboxSettings.allowUnsandboxedFallback
												)
													void save({ allowUnsandboxedFallback: checked })
											}}>
											Allow unsandboxed fallback
										</VSCodeCheckbox>
										<p className="m-0 text-xs leading-relaxed text-description">
											{SETTINGS_HELP.sandboxFallback}
										</p>
									</div>
									<section
										aria-labelledby="sandbox-execution-host"
										className="flex flex-col items-start gap-2 text-xs leading-relaxed text-description">
										<h4 className="m-0 text-xs font-medium text-foreground" id="sandbox-execution-host">
											Execution host
										</h4>
										{loading && <p className="m-0">Checking execution host…</p>}
										{status && (
											<p className="m-0">
												Host: {status.hostPlatform} · Backend: {status.backend || "none"} · State:{" "}
												{status.effectiveState}
											</p>
										)}
										{!status?.error &&
											limitations.map((limitation) => (
												<p className="m-0" key={limitation} role="note">
													{limitation}
												</p>
											))}
										<Button
											disabled={loading || saving}
											onClick={() => void refresh()}
											size="sm"
											variant="secondary">
											Refresh status
										</Button>
									</section>
									<details>
										<summary className="cursor-pointer text-xs font-medium">About command sandboxing</summary>
										<div className="flex flex-col gap-2 pt-2 text-xs leading-relaxed text-description">
											<p className="m-0">
												{SETTINGS_HELP.sandboxCoverage} {SETTINGS_HELP.sandboxEnabled}
											</p>
											<p className="m-0">{SETTINGS_HELP.sandboxDefault}</p>
											<p className="m-0">{SETTINGS_HELP.sandboxCustom}</p>
										</div>
									</details>
								</div>
							</details>
						</>
					)}
				</div>
			</Section>
		</div>
	)
}
