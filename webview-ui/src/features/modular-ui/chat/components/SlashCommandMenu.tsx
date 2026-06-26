import React, { useCallback, useEffect, useRef } from "react"
import { useMenuAnnouncement } from "@/shared/hooks/useMenuAnnouncement"
import type { SlashCommand } from "@/shared/lib/slash-commands"
import { getMatchingSlashCommands } from "@/shared/lib/slash-commands"
import { useSettingsStore } from "@/features/settings/store/settingsStore"
import ScreenReaderAnnounce from "@/shared/ui/ScreenReaderAnnounce"

interface SlashCommandMenuProps {
	onSelect: (command: SlashCommand) => void
	selectedIndex: number
	setSelectedIndex: (index: number) => void
	onMouseDown: (e: React.MouseEvent) => void
	searchQuery: string
}

const SlashCommandMenu: React.FC<SlashCommandMenuProps> = ({
	onSelect,
	selectedIndex,
	setSelectedIndex,
	onMouseDown,
	searchQuery,
}) => {
	const menuRef = useRef<HTMLDivElement>(null)

	const availableSkills = useSettingsStore((state: any) => state.availableSkills)
	const localWorkflowToggles = useSettingsStore((state: any) => state.localWorkflowToggles)
	const globalWorkflowToggles = useSettingsStore((state: any) => state.globalWorkflowToggles)
	const remoteWorkflowToggles = useSettingsStore((state: any) => state.remoteWorkflowToggles)
	const remoteWorkflows = useSettingsStore((state: any) => state.remoteWorkflows)

	const filteredCommands = getMatchingSlashCommands(
		searchQuery,
		localWorkflowToggles,
		globalWorkflowToggles,
		remoteWorkflowToggles,
		remoteWorkflows,
		availableSkills,
	)
	const defaultCommands = filteredCommands.filter((cmd) => cmd.section === "default" || !cmd.section)
	const workflowCommands = filteredCommands.filter((cmd) => cmd.section === "custom")
	const skillCommands = filteredCommands.filter((cmd) => cmd.section === "skill")

	const getCommandLabel = useCallback((command: SlashCommand) => {
		const description = command.description ? `, ${command.description}` : ""
		return `${command.name}${description}`
	}, [])

	const { announcement } = useMenuAnnouncement({
		items: filteredCommands,
		selectedIndex,
		getItemLabel: getCommandLabel,
	})

	const handleClick = useCallback(
		(command: SlashCommand) => {
			onSelect(command)
		},
		[onSelect],
	)

	useEffect(() => {
		if (menuRef.current) {
			const selectedElement = menuRef.current.querySelector(`#slash-command-menu-item-${selectedIndex}`) as HTMLElement
			if (selectedElement) {
				const menuRect = menuRef.current.getBoundingClientRect()
				const selectedRect = selectedElement.getBoundingClientRect()

				if (selectedRect.bottom > menuRect.bottom) {
					menuRef.current.scrollTop += selectedRect.bottom - menuRect.bottom
				} else if (selectedRect.top < menuRect.top) {
					menuRef.current.scrollTop -= menuRect.top - selectedRect.top
				}
			}
		}
	}, [selectedIndex])

	const renderCommandSection = (commands: SlashCommand[], title: string, indexOffset: number, showDescriptions: boolean) => {
		if (commands.length === 0) {
			return null
		}

		return (
			<>
				<div
					className="text-xs opacity-70 px-3 py-1 font-bold border-b border-(--vscode-editorGroup-border)"
					role="presentation">
					{title}
				</div>
				{commands.map((command, index) => {
					const itemIndex = index + indexOffset
					return (
						<div
							aria-selected={itemIndex === selectedIndex}
							className={`slash-command-menu-item py-2 px-3 cursor-pointer flex flex-col border-b border-(--vscode-editorGroup-border) ${
								itemIndex === selectedIndex
									? "bg-(--vscode-quickInputList-focusBackground) text-(--vscode-quickInputList-focusForeground)"
									: ""
							}`}
							id={`slash-command-menu-item-${itemIndex}`}
							key={command.name}
							onClick={() => handleClick(command)}
							onMouseEnter={() => setSelectedIndex(itemIndex)}
							role="option">
							<div className="font-bold whitespace-nowrap overflow-hidden text-ellipsis">
								<span className="ph-no-capture">/{command.name}</span>
							</div>
							{showDescriptions && command.description && (
								<div className="text-[0.85em] whitespace-normal overflow-hidden text-ellipsis opacity-80">
									<span className="ph-no-capture">{command.description}</span>
								</div>
							)}
						</div>
					)
				})}
			</>
		)
	}

	return (
		<div
			className="absolute bottom-[calc(100%-10px)] left-[15px] right-[15px] overflow-x-hidden z-1000"
			data-testid="slash-commands-menu"
			onMouseDown={onMouseDown}>
			<ScreenReaderAnnounce message={announcement} />
			<div
				aria-activedescendant={filteredCommands.length > 0 ? `slash-command-menu-item-${selectedIndex}` : undefined}
				aria-label="Slash commands"
				className="bg-(--vscode-dropdown-background) border border-(--vscode-editorGroup-border) rounded-[3px] shadow-[0_4px_10px_rgba(0,0,0,0.25)] flex flex-col overflow-y-auto max-h-[min(200px,calc(50vh))] overscroll-contain"
				ref={menuRef}
				role="listbox">
				{filteredCommands.length > 0 ? (
					<>
						{renderCommandSection(defaultCommands, "Default Commands", 0, true)}
						{renderCommandSection(skillCommands, "Skills", defaultCommands.length, true)}
						{renderCommandSection(
							workflowCommands,
							"Workflow Commands",
							defaultCommands.length + skillCommands.length,
							false,
						)}
					</>
				) : (
					<div aria-selected="false" className="py-2 px-3 cursor-default flex flex-col" role="option">
						<div className="text-[0.85em] opacity-70">No matching commands found</div>
					</div>
				)}
			</div>
		</div>
	)
}

export default SlashCommandMenu
