import { useEffect, useState } from "react"
import { supportsCustomModelId } from "@shared/customModelIds"
import PROVIDERS from "@shared/providers/providers.json"
import { convertSubagentRolesToProto } from "@shared/proto-conversions/subagent-roles"
import { type SubagentRole, validateSubagentRoles } from "@shared/subagentRoles"
import { useSettingsStore } from "@/features/settings/store/settingsStore"
import { Button } from "@/shared/ui/button"
import { Input } from "@/shared/ui/input"
import { Switch } from "@/shared/ui/switch"
import { ModelSelectionEditor } from "./ModelSelectionEditor"
import { persistSetting } from "./utils/settingsHandlers"

/** User-global presets for future children, never writes the running main model. */
export function SubagentRolesSection() {
	const roles = useSettingsStore((state) => state.subagentRoles)
	const [catalog, setCatalog] = useState(roles)
	const [editing, setEditing] = useState<number | "new">()
	const [draft, setDraft] = useState<SubagentRole>()
	const [selectionValid, setSelectionValid] = useState(true)
	const [saving, setSaving] = useState(false)
	const [error, setError] = useState<string>()
	useEffect(() => setCatalog(roles), [roles])

	const saveCatalog = async (next: SubagentRole[]): Promise<boolean> => {
		setError(undefined)
		setSaving(true)
		try {
			const validated = validateSubagentRoles(next)
			await persistSetting("subagentRoles", convertSubagentRolesToProto(validated))
			setCatalog(validated)
			return true
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : "Could not save subagent roles")
			return false
		} finally {
			setSaving(false)
		}
	}
	const editRole = (index: number | "new") => {
		setEditing(index)
		setSelectionValid(true)
		setDraft(index === "new" ? { name: "", description: "", enabled: false } : structuredClone(catalog[index]))
		setError(undefined)
	}
	const closeEditor = () => {
		setEditing(undefined)
		setDraft(undefined)
		setError(undefined)
	}
	const saveDraft = async () => {
		if (!draft || editing === undefined || !selectionValid) return
		const next = editing === "new" ? [...catalog, draft] : catalog.map((role, index) => index === editing ? draft : role)
		if (await saveCatalog(next)) closeEditor()
	}
	const removeRole = async () => {
		if (typeof editing !== "number") return
		if (await saveCatalog(catalog.filter((_, index) => index !== editing))) closeEditor()
	}
	const editor = draft && editing !== undefined && (
		<fieldset disabled={saving} aria-label="Role settings" className="m-0 min-w-0 space-y-3 rounded-md border border-(--vscode-panel-border) p-3">
			<label className="block space-y-1 text-xs">
				<span>Name</span>
				<Input aria-label="Role name" value={draft.name} onChange={(event) => setDraft({ ...draft, name: event.target.value })} />
			</label>
			<label className="block space-y-1 text-xs">
				<span>Description</span>
				<Input aria-label="Role description" value={draft.description} onChange={(event) => setDraft({ ...draft, description: event.target.value })} />
			</label>
			<ModelSelectionEditor key={editing} label="Role" selection={draft.modelSelection} allowCustomModelId={supportsCustomModelId} onValidityChange={setSelectionValid} onChange={(modelSelection) => setDraft({ ...draft, modelSelection })} />
			<div className="flex items-center gap-2 text-xs">
				<Switch id="subagent-role-enabled" aria-label="Role enabled" checked={draft.enabled} disabled={saving || !draft.modelSelection || !selectionValid} onCheckedChange={(enabled) => setDraft({ ...draft, enabled })} />
				<label htmlFor="subagent-role-enabled">Enable role</label>
				{!draft.modelSelection && <span className="text-description">Select a model first.</span>}
			</div>
			<p className="text-xs text-description">Save or cancel before configuring another role.</p>
			<div className="flex flex-wrap items-center gap-2">
				<Button type="button" size="sm" disabled={saving || !selectionValid} onClick={() => void saveDraft()}>Save role</Button>
				<Button type="button" size="sm" variant="secondary" disabled={saving} onClick={closeEditor}>Cancel</Button>
				{typeof editing === "number" && <Button type="button" size="sm" variant="ghost" className="ml-auto text-error" aria-label={`Remove ${catalog[editing].name}`} disabled={saving} onClick={() => void removeRole()}>Remove</Button>}
			</div>
		</fieldset>
	)

	return (
		<section className="mt-4 space-y-2" aria-label="Subagent roles">
			<h3 className="text-sm font-medium">Subagent roles</h3>
			<p className="text-xs text-description">Subagents use the current model by default. Enabled roles make alternative models available for specific kinds of work.</p>
			{catalog.map((role, index) => {
				const selection = role.modelSelection
				const provider = selection && (PROVIDERS.list.find((entry) => entry.value === selection.provider)?.label ?? selection.provider)
				const modelSummary = selection
					? `${provider}${selection.openAiProfileName ? ` (${selection.openAiProfileName})` : ""} / ${selection.modelId}`
					: "No model selected"
				return (
					<div key={role.name} className="border-b border-(--vscode-panel-border) pb-2">
						<div className="flex items-center gap-2 py-2">
							<div className="min-w-0 flex-1">
								<div className="truncate text-sm font-medium" title={role.description}>{role.name}</div>
								<div className="truncate text-xs text-description" title={modelSummary}>{modelSummary}</div>
							</div>
							{selection ? <div className="flex shrink-0 items-center gap-1.5 text-xs">
								<Switch id={`subagent-role-${index}`} aria-label={`Enable ${role.name}`} checked={role.enabled} disabled={saving || editing !== undefined}
									onCheckedChange={(enabled) => { void saveCatalog(catalog.map((entry, i) => i === index ? { ...entry, enabled } : entry)) }} />
								<label htmlFor={`subagent-role-${index}`}>{role.enabled ? "Enabled" : "Disabled"}</label>
							</div> : <span className="shrink-0 text-xs text-description">Not configured</span>}
							<Button type="button" size="sm" variant="secondary" aria-label={`${selection ? "Edit" : "Configure"} ${role.name}`} disabled={saving || editing !== undefined} onClick={() => editRole(index)}>{selection ? "Edit" : "Configure"}</Button>
						</div>
						{editing === index && editor}
					</div>
				)
			})}
			{editing === "new" && editor}
			{editing === undefined && <Button type="button" size="sm" variant="secondary" disabled={saving} onClick={() => editRole("new")}>Add role</Button>}
			{error && <p role="alert" className="text-xs text-error">{error}</p>}
		</section>
	)
}
