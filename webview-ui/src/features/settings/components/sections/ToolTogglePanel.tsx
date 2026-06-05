import { UpdateSettingsRequest } from "@shared/proto/dirac/state"
import type { ToolMetadata } from "@shared/ExtensionMessage"
import { memo, useCallback, useMemo, useState } from "react"
import { useSettingsStore } from "@/features/settings/store/settingsStore"
import { Switch } from "@/shared/ui/switch"
import { cn } from "@/lib/utils"
import Section from "../Section"
import { StateServiceClient } from "@/shared/api/grpc-client"

const SOURCE_LABELS: Record<string, string> = {
	builtin: "Built-in",
	global: "Global",
	workspace: "Workspace",
}

const SOURCE_ORDER: Array<ToolMetadata["source"]> = ["builtin", "global", "workspace"]

interface ToolToggleRowProps {
	tool: ToolMetadata
	enabled: boolean
	onToggle: (toolId: string, enabled: boolean) => void
}

const ToolToggleRow = memo(({ tool, enabled, onToggle }: ToolToggleRowProps) => (
	<div className="flex items-center justify-between py-2 px-1">
		<div className="flex-1 min-w-0 mr-4">
			<div className="flex items-center gap-2">
				<span className="text-sm font-medium truncate">{tool.name}</span>
				<span
					className={cn(
						"text-[10px] px-1.5 py-0.5 rounded font-medium shrink-0",
						tool.source === "builtin"
							? "bg-[var(--vscode-badge-background)] text-[var(--vscode-badge-foreground)]"
							: tool.source === "global"
								? "bg-[var(--vscode-terminal-ansiBlue)] text-[var(--vscode-editor-background)]"
								: "bg-[var(--vscode-terminal-ansiGreen)] text-[var(--vscode-editor-background)]",
					)}>
					{SOURCE_LABELS[tool.source]}
				</span>
			</div>
			<p className="text-xs text-description mt-0.5 mb-0 line-clamp-2">{tool.description}</p>
		</div>
		<Switch
			checked={enabled}
			className="shrink-0"
			id={`tool-toggle-${tool.id}`}
			onCheckedChange={(checked) => onToggle(tool.id, checked)}
			size="lg"
		/>
	</div>
))
ToolToggleRow.displayName = "ToolToggleRow"

interface ToolTogglePanelProps {
	renderSectionHeader: (tabId: string) => JSX.Element | null
}

const ToolTogglePanel = ({ renderSectionHeader }: ToolTogglePanelProps) => {
	const { availableTools, toolToggles } = useSettingsStore()
	const [searchQuery, setSearchQuery] = useState("")

	const filteredTools = useMemo(() => {
		if (!searchQuery.trim()) return availableTools
		const query = searchQuery.toLowerCase()
		return availableTools.filter(
			(tool) => tool.name.toLowerCase().includes(query) || tool.description.toLowerCase().includes(query),
		)
	}, [availableTools, searchQuery])

	const groupedTools = useMemo(() => {
		const groups: Record<string, ToolMetadata[]> = {}
		for (const source of SOURCE_ORDER) {
			const tools = filteredTools.filter((t) => t.source === source)
			if (tools.length > 0) {
				groups[source] = tools.sort((a, b) => a.name.localeCompare(b.name))
			}
		}
		return groups
	}, [filteredTools])

	const handleToggle = useCallback(
		(toolId: string, enabled: boolean) => {
			const newToggles = { ...toolToggles, [toolId]: enabled }
			StateServiceClient.updateSettings(
				UpdateSettingsRequest.create({ toolToggles: JSON.stringify(newToggles) }),
			).catch((error: unknown) => {
				console.error("Failed to toggle tool:", error)
			})
		},
		[toolToggles],
	)

	const isToolEnabled = useCallback(
		(tool: ToolMetadata) => {
			const override = toolToggles[tool.id]
			if (override !== undefined) return override
			return tool.source === "builtin"
		},
		[toolToggles],
	)

	return (
		<div className="mb-2">
			{renderSectionHeader("tools")}
			<Section>
				<div className="mb-3">
					<input
						className="w-full px-3 py-1.5 text-sm bg-[var(--vscode-input-background)] text-[var(--vscode-input-foreground)] border border-[var(--vscode-input-border)] rounded outline-none focus:border-[var(--vscode-focusBorder)]"
						onChange={(e) => setSearchQuery(e.target.value)}
						placeholder="Search tools..."
						type="text"
						value={searchQuery}
					/>
				</div>

				{filteredTools.length === 0 ? (
					<div className="text-sm text-description py-4 text-center">
						{availableTools.length === 0 ? "No tools discovered yet." : "No tools match your search."}
					</div>
				) : (
					<div className="flex flex-col gap-1">
						{SOURCE_ORDER.map((source) => {
							const tools = groupedTools[source]
							if (!tools?.length) return null
							return (
								<div key={source}>
									<div className="text-xs font-medium text-foreground/80 uppercase tracking-wider mt-4 mb-2">
										{SOURCE_LABELS[source]} Tools
									</div>
									<div className="relative rounded-md border border-[var(--vscode-widget-border)]">
										{tools.map((tool) => (
											<ToolToggleRow
												enabled={isToolEnabled(tool)}
												key={tool.id}
												onToggle={handleToggle}
												tool={tool}
											/>
										))}
									</div>
								</div>
							)
						})}
					</div>
				)}
			</Section>
		</div>
	)
}

export default memo(ToolTogglePanel)
