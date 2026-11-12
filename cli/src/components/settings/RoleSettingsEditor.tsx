import React, { useState } from "react"
import { Box, Text, useInput } from "ink"
import type { SubagentRole } from "@shared/subagentRoles"
import { SETTINGS_HELP } from "@shared/settings-presentation"
import type { Controller } from "@/core/controller"
import { getProviderLabel } from "../../utils/providers"
import { theme } from "../../constants/theme"
import { SearchableList } from "../SearchableList"
import { ModelSelectionEditor } from "./ModelSelectionEditor"

interface Props {
	role?: SubagentRole
	controller?: Controller
	onSave: (role: SubagentRole) => Promise<void>
	onRemove?: () => Promise<void>
	onCancel: () => void
}

/** A role draft uses the same independent model input as Utility. */
export const RoleSettingsEditor: React.FC<Props> = ({ role, controller, onSave, onRemove, onCancel }) => {
	const [draft, setDraft] = useState<SubagentRole>(() => structuredClone(role ?? { name: "", description: "", enabled: false }))
	const [field, setField] = useState<"name" | "description" | "model" | null>(null)
	const [text, setText] = useState("")
	const [error, setError] = useState("")
	const [busy, setBusy] = useState(false)
	const persist = async (action: () => Promise<void>) => {
		setBusy(true)
		setError("")
		try { await action() }
		catch (failure) { setError(failure instanceof Error ? failure.message : String(failure)) }
		finally { setBusy(false) }
	}
	useInput((input, key) => {
		if (busy || field === "model") return
		if (key.escape) { if (field) setField(null); else onCancel(); return }
		if (!field) return
		if (key.return) { setDraft({ ...draft, [field]: text }); setField(null); return }
		if (key.backspace || key.delete) setText((value) => value.slice(0, -1))
		else if (input && !key.ctrl && !key.meta) setText((value) => value + input)
	})
	if (field === "model") return <ModelSelectionEditor value={draft.modelSelection} controller={controller}
		onCancel={() => setField(null)} onSave={async (modelSelection) => { setDraft({ ...draft, modelSelection }); setField(null) }} />
	const selection = draft.modelSelection
	return <Box flexDirection="column">
		<Text>{role ? `Edit ${role.name}` : "Add subagent role"}</Text>
		<Text color={theme.muted}>{SETTINGS_HELP.subagentRoleDescription}</Text>
		{error && <Text color={theme.error}>{error}</Text>}
		{field ? <Text>{field === "name" ? "Name" : "Description"}: {text}▏</Text> : <SearchableList isActive={!busy} items={[
			{ id: "name", label: `Name: ${draft.name || "Required"}` },
			{ id: "description", label: `Description: ${draft.description || "Required (one sentence)"}` },
			{ id: "enabled", label: `Enabled: ${draft.enabled ? "Yes" : "No"}` },
			{ id: "model", label: `Model: ${selection ? `${selection.openAiProfileName ?? getProviderLabel(selection.provider)} · ${selection.modelId}` : "Not configured"}` },
			{ id: "save", label: "Save role" },
			...(onRemove ? [{ id: "remove", label: "Remove role" }] : []),
		]} onSelect={(item) => {
			if (item.id === "save") { void persist(() => onSave(draft)); return }
			if (item.id === "remove" && onRemove) { void persist(onRemove); return }
			if (item.id === "enabled") { setDraft({ ...draft, enabled: !draft.enabled }); return }
			if (item.id === "name" || item.id === "description") { setText(draft[item.id]); setField(item.id); return }
			if (item.id === "model") setField("model")
		}} />}
		<Text color={theme.muted}>{busy ? "Saving…" : "Enter select/save · Esc cancel"}</Text>
	</Box>
}
