import {
	SANDBOX_CAPABILITY_ROWS,
	sandboxAdditionalFolders,
	sandboxCapabilityValue,
	updateSandboxAdditionalFolders,
	updateSandboxCapability,
} from "@shared/SandboxCapabilities"
import { type CustomSandboxProfile, validateCustomSandboxProfile } from "@shared/SandboxSettings"
import {
	SANDBOX_PROFILE_FIELDS,
	type SandboxProfileDraft,
	SETTINGS_HELP,
	sandboxProfileDraft,
	sandboxProfileFromDraft,
} from "@shared/settings-presentation"
import { CircleHelp } from "lucide-react"
import { type CSSProperties, useEffect, useRef, useState } from "react"
import { Button } from "@/shared/ui/button"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/shared/ui/select"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/shared/ui/tooltip"

const stack: CSSProperties = { display: "flex", flexDirection: "column", gap: 12, minWidth: 0 }
const row: CSSProperties = { display: "flex", flexWrap: "wrap", alignItems: "center", gap: 8, minWidth: 0 }
const group: CSSProperties = {
	...stack,
	paddingTop: 16,
	borderTop: "1px solid var(--vscode-panel-border)",
}
const help: CSSProperties = { margin: 0, color: "var(--vscode-descriptionForeground)", fontSize: 12, lineHeight: 1.5 }
const disclosure: CSSProperties = { cursor: "pointer", fontWeight: 500, lineHeight: 1.5 }
const control: CSSProperties = {
	width: "100%",
	minWidth: 0,
	boxSizing: "border-box",
	padding: "6px 8px",
	borderRadius: 2,
	font: "inherit",
	color: "var(--vscode-input-foreground)",
	background: "var(--vscode-input-background)",
	border: "1px solid var(--vscode-input-border, var(--vscode-panel-border))",
}
const folderOptions = [
	{ value: "read-only", label: "Read-only" },
	{ value: "read-write", label: "Read/write" },
	{ value: "blocked", label: "Blocked" },
] as const

function CapabilityHelp({ label, text }: { label: string; text: string }) {
	return (
		<Tooltip>
			<TooltipTrigger asChild>
				<button
					aria-label={`About ${label.toLowerCase()}`}
					className="inline-flex shrink-0 items-center justify-center rounded-sm border-0 bg-transparent p-0.5 text-(--vscode-descriptionForeground) hover:text-(--vscode-foreground) focus-visible:outline focus-visible:outline-1 focus-visible:outline-(--vscode-focusBorder)"
					style={{ cursor: "help" }}
					type="button">
					<CircleHelp aria-hidden="true" size={14} />
				</button>
			</TooltipTrigger>
			<TooltipContent style={{ maxWidth: 320 }}>{text}</TooltipContent>
		</Tooltip>
	)
}

export default function SandboxProfileEditor({
	profile,
	duplicate,
	onSave,
	onCancel,
}: {
	profile?: CustomSandboxProfile
	duplicate?: boolean
	onSave: (profile: CustomSandboxProfile) => Promise<void>
	onCancel: () => void
}) {
	const [draft, setDraft] = useState(() => sandboxProfileDraft(profile, duplicate))
	const [folders, setFolders] = useState(() =>
		sandboxAdditionalFolders(draft).map((folder) => ({ ...folder, rowId: crypto.randomUUID() })),
	)
	const nameInput = useRef<HTMLInputElement>(null)
	useEffect(() => {
		nameInput.current?.focus()
	}, [])
	const [id] = useState(() => (!duplicate && profile ? profile.id : `custom-${crypto.randomUUID()}`))
	const [error, setError] = useState("")
	const [busy, setBusy] = useState(false)
	const updateFolders = (next: typeof folders) => {
		setFolders(next)
		setDraft(updateSandboxAdditionalFolders(draft, next))
	}
	const updateRawField = (key: keyof SandboxProfileDraft, value: string) => {
		const next = { ...draft, [key]: value }
		setDraft(next)
		if (key === "readable" || key === "writable" || key === "blocked")
			setFolders(sandboxAdditionalFolders(next).map((folder) => ({ ...folder, rowId: crypto.randomUUID() })))
	}
	const save = async () => {
		setBusy(true)
		setError("")
		try {
			if (folders.some((folder) => !folder.path.trim()))
				throw new Error("Enter a path for each additional folder or remove its row.")
			await onSave(
				validateCustomSandboxProfile(sandboxProfileFromDraft(draft, id, duplicate ? 1 : (profile?.revision ?? 1))),
			)
		} catch (failure) {
			setError(String(failure))
		} finally {
			setBusy(false)
		}
	}
	return (
		<form
			className="max-w-2xl"
			onSubmit={(event) => {
				event.preventDefault()
				void save()
			}}
			style={{ ...stack, gap: 16, padding: "12px 16px 20px", overflowWrap: "anywhere" }}>
			<header style={{ ...stack, gap: 4 }}>
				<h3 style={{ margin: 0, fontSize: 14, fontWeight: 600 }}>
					{duplicate ? "Copy profile" : profile ? "Edit profile" : "New profile"}
				</h3>
				<p style={help}>Save this profile, then assign it to an agent separately.</p>
			</header>
			<div style={{ ...stack, gap: 4 }}>
				<label htmlFor="profile-name">Name</label>
				<input
					className="focus:outline focus:outline-1 focus:outline-(--vscode-focusBorder)"
					disabled={busy}
					id="profile-name"
					onChange={(event) => setDraft({ ...draft, name: event.target.value })}
					ref={nameInput}
					style={control}
					value={draft.name}
				/>
			</div>
			<section aria-labelledby="profile-capabilities" style={group}>
				<h4 id="profile-capabilities" style={{ margin: 0, fontSize: 13, fontWeight: 600 }}>
					Capabilities
				</h4>
				{SANDBOX_CAPABILITY_ROWS.filter((capability) => capability.key !== "packageCaches").map((capability) => (
					<fieldset
						aria-label={capability.label}
						disabled={busy}
						key={capability.key}
						style={{ ...stack, gap: 6, border: 0, padding: 0, margin: 0 }}>
						<div style={{ ...row, gap: 4 }}>
							<span style={{ fontWeight: 500 }}>{capability.label}</span>
							<CapabilityHelp label={capability.label} text={capability.help} />
						</div>
						<div style={{ ...row, columnGap: 16 }}>
							{capability.options.map((option) => (
								<label key={option.value} style={{ ...row, gap: 6, cursor: "pointer" }}>
									<input
										checked={sandboxCapabilityValue(draft, capability.key) === option.value}
										className="m-0 accent-(--vscode-focusBorder)"
										name={`capability-${capability.key}`}
										onChange={() => setDraft(updateSandboxCapability(draft, capability.key, option.value))}
										type="radio"
										value={option.value}
									/>
									{option.label}
								</label>
							))}
						</div>
					</fieldset>
				))}
			</section>
			<details style={group}>
				<summary style={disclosure}>
					Package cache directories{draft.caches ? ` (${draft.caches.split("\n").filter(Boolean).length})` : ""}
				</summary>
				<div style={{ ...stack, gap: 4, paddingTop: 8 }}>
					<div style={row}>
						<label htmlFor="profile-caches">Writable cache directories</label>
						<CapabilityHelp
							label="cache directories"
							text="Exact absolute or ~/ directory paths, one per line. These grants add read/write access; removing a cache grant does not block access already granted by workspace or other host files. No home directory or cache parent is granted implicitly."
						/>
					</div>
					<textarea
						disabled={busy}
						id="profile-caches"
						onChange={(event) => setDraft({ ...draft, caches: event.target.value })}
						rows={2}
						style={control}
						value={draft.caches}
					/>
				</div>
			</details>
			<section aria-labelledby="additional-folders" style={group}>
				<h4 id="additional-folders" style={{ margin: 0, fontSize: 13, fontWeight: 600 }}>
					Additional folders
				</h4>
				{folders.map((folder, index) => (
					<fieldset
						disabled={busy}
						key={folder.rowId}
						style={{
							minWidth: 0,
							border: "1px solid var(--vscode-panel-border)",
							borderRadius: 4,
							padding: 10,
							margin: 0,
						}}>
						<legend style={{ padding: "0 4px", color: "var(--vscode-descriptionForeground)" }}>
							Folder {index + 1}
						</legend>
						<div style={{ ...stack, gap: 4 }}>
							<label htmlFor={`folder-${index}`}>Path</label>
							<input
								className="focus:outline focus:outline-1 focus:outline-(--vscode-focusBorder)"
								id={`folder-${index}`}
								onChange={(event) =>
									updateFolders(
										folders.map((entry, position) =>
											position === index ? { ...entry, path: event.target.value } : entry,
										),
									)
								}
								style={control}
								value={folder.path}
							/>
						</div>
						<div style={{ ...row, columnGap: 12, marginTop: 10 }}>
							{folderOptions.map((option) => (
								<label key={option.value} style={{ ...row, gap: 4, cursor: "pointer" }}>
									<input
										checked={folder.access === option.value}
										className="m-0 accent-(--vscode-focusBorder)"
										name={`folder-access-${index}`}
										onChange={() =>
											updateFolders(
												folders.map((entry, position) =>
													position === index ? { ...entry, access: option.value } : entry,
												),
											)
										}
										type="radio"
										value={option.value}
									/>
									{option.label}
								</label>
							))}
						</div>
						<div style={{ ...row, justifyContent: "flex-end", marginTop: 10 }}>
							<Button
								aria-label={`Remove folder ${index + 1}`}
								onClick={() => updateFolders(folders.filter((_, position) => position !== index))}
								size="sm"
								type="button"
								variant="secondary">
								Remove
							</Button>
						</div>
					</fieldset>
				))}
				<div>
					<Button
						disabled={busy}
						onClick={() => updateFolders([...folders, { path: "", access: "read-only", rowId: crypto.randomUUID() }])}
						size="sm"
						type="button"
						variant="secondary">
						Add folder
					</Button>
				</div>
			</section>
			<details style={group}>
				<summary style={disclosure}>Advanced</summary>
				<div style={{ ...stack, paddingTop: 8 }}>
					{SANDBOX_PROFILE_FIELDS.filter(
						(field) => !["name", "workspace", "network", "caches"].includes(field.key),
					).map((field) => (
						<div key={field.key} style={{ ...stack, gap: 4 }}>
							<div style={row}>
								<label htmlFor={`profile-${field.key}`}>{field.label}</label>
								<CapabilityHelp label={field.label} text={field.help} />
							</div>
							{"options" in field ? (
								<Select
									disabled={busy}
									onValueChange={(value) => updateRawField(field.key, value)}
									value={draft[field.key]}>
									<SelectTrigger className="w-full text-xs" id={`profile-${field.key}`} size="sm">
										<SelectValue />
									</SelectTrigger>
									<SelectContent align="start">
										{field.options.map((option) => (
											<SelectItem key={option} value={option}>
												{(field.optionLabels as Record<string, string>)[option]}
											</SelectItem>
										))}
									</SelectContent>
								</Select>
							) : (
								<textarea
									disabled={busy}
									id={`profile-${field.key}`}
									onChange={(event) => updateRawField(field.key, event.target.value)}
									rows={2}
									style={control}
									value={draft[field.key]}
								/>
							)}
						</div>
					))}
					<details>
						<summary style={disclosure}>Exact path and runtime rules</summary>
						<p style={help}>{SETTINGS_HELP.sandboxPaths}</p>
					</details>
				</div>
			</details>
			<details>
				<summary style={disclosure}>Profile help</summary>
				<p style={help}>
					Saving does not assign this profile. Choose it separately for the main agent or subagents.{" "}
					{SETTINGS_HELP.sandboxCoverage}
				</p>
			</details>
			{error && (
				<p role="alert" style={{ margin: 0, color: "var(--vscode-errorForeground)" }}>
					{error}
				</p>
			)}
			<div style={{ ...row, borderTop: "1px solid var(--vscode-panel-border)", paddingTop: 12 }}>
				<Button disabled={busy} size="sm" type="submit">
					Save profile
				</Button>
				<Button disabled={busy} onClick={onCancel} size="sm" type="button" variant="secondary">
					Cancel
				</Button>
			</div>
		</form>
	)
}
