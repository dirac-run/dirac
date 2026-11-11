import type { CustomSandboxProfile } from "@shared/SandboxSettings"
import {
	SANDBOX_CAPABILITY_ROWS,
	sandboxCapabilityValue,
	updateSandboxCapability,
	sandboxAdditionalFolders,
	updateSandboxAdditionalFolders,
} from "@shared/SandboxCapabilities"
import {
	SANDBOX_PROFILE_FIELDS,
	SETTINGS_HELP,
	sandboxProfileDraft,
	sandboxProfileFromDraft,
} from "@shared/settings-presentation"
import { Box, Text, useInput } from "ink"
// biome-ignore lint/correctness/noUnusedImports: CLI uses the classic JSX runtime.
import React, { useState } from "react"
import { randomUUID } from "node:crypto"
import wrapAnsi from "wrap-ansi"
import { theme } from "../../constants/theme"
import { SandboxTechnicalDetails } from "./SandboxTechnicalDetails"
import { useTerminalSize } from "../../hooks/useTerminalSize"

type Option = { value: string; label: string }
type EditorRow = {
	id: string
	label: string
	help: string
	value?: string
	editValue?: string
	options?: readonly Option[]
	change?: (value: string) => void
	edit?: (text: string) => void
	activate?: () => void
	multiline?: boolean
}
const folderOptions: readonly Option[] = [
	{ value: "blocked", label: "Blocked" },
	{ value: "read-only", label: "Read only" },
	{ value: "read-write", label: "Read & write" },
]

export function SandboxProfileEditor({
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
	const { rows: terminalRows, columns } = useTerminalSize()
	const [draft, setDraft] = useState(() => sandboxProfileDraft(profile, duplicate))
	const [id] = useState(() => (!duplicate && profile ? profile.id : `custom-${randomUUID()}`))
	const [cachePaths, setCachePaths] = useState(() => profile?.filesystem.caches ?? [])
	const [selected, setSelected] = useState(0)
	const [editing, setEditing] = useState<EditorRow>()
	const [text, setText] = useState("")
	const [advanced, setAdvanced] = useState(false)
	const [help, setHelp] = useState<string>()
	const [details, setDetails] = useState(false)
	const [error, setError] = useState("")
	const [busy, setBusy] = useState(false)
	const folders = sandboxAdditionalFolders(draft)
	const save = async () => {
		setBusy(true)
		setError("")
		try {
			await onSave(sandboxProfileFromDraft(draft, id, duplicate ? 1 : (profile?.revision ?? 1)))
		} catch (failure) {
			setError(String(failure))
		} finally {
			setBusy(false)
		}
	}
	const fieldRow = (field: (typeof SANDBOX_PROFILE_FIELDS)[number]): EditorRow => ({
		id: field.key,
		label: field.label,
		help: field.help,
		value: draft[field.key],
		...("options" in field
			? {
				options: field.options.map((value) => ({
					value,
					label: field.optionLabels[value as keyof typeof field.optionLabels],
				})),
				change: (value: string) => setDraft({ ...draft, [field.key]: value }),
			}
			: {
				multiline: ["readable", "writable", "blocked", "caches", "passthrough", "overrides"].includes(field.key),
				edit: (value: string) => {
					setDraft({ ...draft, [field.key]: value })
					if (field.key === "caches") setCachePaths(value.split("\n").filter(Boolean))
				},
			}),
	})
	const capabilityRows = SANDBOX_CAPABILITY_ROWS.filter(
		(row) => row.key !== "packageCaches" || cachePaths.length > 0 || draft.caches !== "",
	)
	const editFolderDraft = (nextFolders: typeof folders, focusedPath: string) => {
		const nextDraft = updateSandboxAdditionalFolders(draft, nextFolders)
		setDraft(nextDraft)
		const folderIndex = sandboxAdditionalFolders(nextDraft).findIndex((folder) => folder.path === focusedPath)
		setSelected(1 + capabilityRows.length + folderIndex * 2)
	}
	const editorRows: EditorRow[] = [
		fieldRow(SANDBOX_PROFILE_FIELDS[0]),
		...capabilityRows.map(
			(row): EditorRow => ({
				id: `capability:${row.key}`,
				label: row.label,
				help: row.help,
				options: row.options,
				value: sandboxCapabilityValue(draft, row.key),
				change: (value) => setDraft(updateSandboxCapability(draft, row.key, value, cachePaths)),
				...(row.key === "packageCaches"
					? {
						editValue: cachePaths.join("\n"),
						multiline: true,
						edit: (value: string) => {
							setCachePaths(value.split("\n").filter(Boolean))
							setDraft({ ...draft, caches: value })
						},
					}
					: {}),
			}),
		),
		...folders.flatMap((folder, index): EditorRow[] => [
			{
				id: `folder:${index}`,
				label: folder.path,
				help: "Left/right changes access. Enter edits the path. Use Remove to delete this grant.",
				value: folder.access,
				options: folderOptions,
				change: (access) =>
					editFolderDraft(
						folders.map((item, i) => (i === index ? { ...item, access: access as typeof folder.access } : item)),
						folder.path,
					),
				edit: (path) =>
					editFolderDraft(
						folders.map((item, i) => (i === index ? { ...item, path } : item)),
						path,
					),
			},
			{
				id: `remove:${index}`,
				label: `Remove ${folder.path}`,
				help: "Remove this folder grant from the draft.",
				activate: () => {
					setDraft(
						updateSandboxAdditionalFolders(
							draft,
							folders.filter((_, i) => i !== index),
						),
					)
					setSelected(Math.max(0, selected - 1))
				},
			},
		]),
		{
			id: "addFolder",
			label: "Add folder…",
			help: SETTINGS_HELP.sandboxPaths,
			edit: (path) => editFolderDraft([...folders, { path, access: "read-only" }], path),
		},
		{
			id: "advanced",
			label: advanced ? "▾ Advanced" : "▸ Advanced",
			help: "Optional technical fields. Existing values are retained unless edited.",
			activate: () => setAdvanced(!advanced),
		},
		...(advanced ? SANDBOX_PROFILE_FIELDS.filter((field) => field.key !== "name").map(fieldRow) : []),
		{
			id: "details",
			label: "Technical details",
			help: "Read command coverage, platform restrictions and path rules.",
			activate: () => setDetails(true),
		},
		{
			id: "save",
			label: "Save profile",
			help: "Persist this draft only. Choose a profile in the main agent or subagent selector to assign it.",
			activate: () => {
				void save()
			},
		},
		{ id: "cancel", label: "Cancel", help: "Discard this draft without saving.", activate: onCancel },
	]
	const focused = editorRows[Math.min(selected, editorRows.length - 1)]!
	useInput((input, key) => {
		if (busy || details) return
		if (help) {
			if (key.escape || input === "?") setHelp(undefined)
			return
		}
		if (editing) {
			if (key.escape) {
				setEditing(undefined)
				return
			}
			if (key.return) {
				if ((editing.id === "addFolder" || editing.id.startsWith("folder:")) && !text.trim()) {
					setError("Enter an absolute or ~/ folder path.")
					return
				}
				editing.edit!(text)
				setEditing(undefined)
				setError("")
				return
			}
			if (key.tab) {
				if (editing.multiline) setText((value) => `${value}\n`)
				return
			}
			if (key.backspace || key.delete) setText((value) => value.slice(0, -1))
			else if (input && !key.ctrl && !key.meta) setText((value) => value + input)
			return
		}
		if (key.escape) {
			onCancel()
			return
		}
		if (input === "?") {
			setHelp(focused.help)
			return
		}
		if (key.upArrow) {
			setSelected(Math.max(0, selected - 1))
			return
		}
		if (key.downArrow) {
			setSelected(Math.min(editorRows.length - 1, selected + 1))
			return
		}
		if ((key.leftArrow || key.rightArrow) && focused.options) {
			const index = focused.options.findIndex((option) => option.value === focused.value)
			focused.change!(
				focused.options[(index + (key.leftArrow ? -1 : 1) + focused.options.length) % focused.options.length]!.value,
			)
			return
		}
		if (!key.return) return
		if (focused.edit) {
			setText(focused.editValue ?? (focused.id.startsWith("folder:") ? focused.label : (focused.value ?? "")))
			setEditing(focused)
			return
		}
		if (focused.activate) {
			focused.activate()
			return
		}
		if (focused.options) {
			const index = focused.options.findIndex((option) => option.value === focused.value)
			focused.change!(focused.options[(index + 1) % focused.options.length]!.value)
		}
	})
	if (details)
		return (
			<SandboxTechnicalDetails
				details={[
					SETTINGS_HELP.sandboxCreate,
					SETTINGS_HELP.sandboxCustom,
					SETTINGS_HELP.sandboxCoverage,
					SETTINGS_HELP.sandboxPaths,
				].join("\n\n")}
				onClose={() => setDetails(false)}
			/>
		)
	const width = Math.max(12, columns - 8)
	const optionText = (row: EditorRow) =>
		row.options?.map((option) => `${option.value === row.value ? "◉" : "○"} ${option.label}`).join("  ")
	const wrapOptions = (row: EditorRow) => Boolean(row.options && row.label.length + (optionText(row)?.length ?? 0) + 4 > width)
	const rowText = (row: EditorRow) =>
		row.options
			? `${row.label}${wrapOptions(row) ? "\n  " : "  "}${optionText(row)}`
			: `${row.label}${row.value !== undefined ? `: ${row.value.replaceAll("\n", "; ") || "(empty)"}` : ""}`
	const height = (row: EditorRow) => wrapAnsi(`  ${rowText(row)}`, width, { hard: true }).split("\n").length
	const budget = Math.max(2, terminalRows - 12)
	let start = Math.min(selected, editorRows.length - 1),
		end = start + 1,
		used = height(focused)
	while (start > 0 && used + height(editorRows[start - 1]!) <= budget) used += height(editorRows[--start]!)
	while (end < editorRows.length && used + height(editorRows[end]!) <= budget) used += height(editorRows[end++]!)
	return (
		<Box flexDirection="column">
			<Text bold>{duplicate ? "Customize profile copy" : profile ? "Edit profile" : "Create profile"}</Text>
			{error && <Text color={theme.error}>{error}</Text>}
			{help ? (
				<Box flexDirection="column">
					<Text>{help}</Text>
					<Text color={theme.muted}>? or Esc back</Text>
				</Box>
			) : editing ? (
				<Box flexDirection="column">
					<Text bold>{editing.id.startsWith("folder:") ? "Folder path" : editing.label}</Text>
					<Text>{text}▏</Text>
					<Text color={theme.muted}>
						{editing.multiline ? "Tab adds line · " : ""}Enter applies · Esc discards field · ? help when browsing
					</Text>
				</Box>
			) : (
				<Box flexDirection="column" width={width}>
					{start > 0 && <Text color={theme.muted}>… more above</Text>}
					{editorRows.slice(start, end).map((row) => (
						<Box key={row.id} flexDirection="column">
							<Text color={row === focused ? theme.primary : theme.text}>
								{row === focused ? "❯" : " "} {row.options ? row.label : rowText(row)}
								{row.options && !wrapOptions(row) ? "  " : ""}
								{row.options && !wrapOptions(row) ? optionText(row) : ""}
							</Text>
							{row.options && wrapOptions(row) && (
								<Box paddingLeft={2}>
									<Text color={row === focused ? theme.primary : theme.text}>{optionText(row)}</Text>
								</Box>
							)}
						</Box>
					))}
					{end < editorRows.length && <Text color={theme.muted}>… more below</Text>}
				</Box>
			)}
			{!editing && !help && (
				<Text color={theme.muted}>
					{busy ? "Saving…" : "↑/↓ focus · ←/→ change · Enter edit/select · ? help · Esc cancel"}
				</Text>
			)}
		</Box>
	)
}
