import ContextMenu from "../components/ContextMenu"
import SlashCommandMenu from "../components/SlashCommandMenu"
import { ContextMenuOptionType } from "@/shared/lib/context-mentions"
import { InputDecorator, ModularInputContext } from "../types"

interface OverlayDecoratorProps {
	mentionTrait: any
	slashCommandTrait: any
}

export const createOverlayDecorator = (mentionTrait: any, slashCommandTrait: any): InputDecorator => ({
	id: "overlay",
	renderOverlay: (context: ModularInputContext) => (
		<>
			{mentionTrait.showContextMenu && (
				<ContextMenu
					onSelect={(type: ContextMenuOptionType, value?: string) =>
						mentionTrait.handleMentionSelect(type, value, context)
					}
					searchQuery={mentionTrait.searchQuery}
					onMouseDown={() => {}}
					selectedIndex={mentionTrait.selectedMenuIndex}
					setSelectedIndex={mentionTrait.setSelectedMenuIndex}
					selectedType={mentionTrait.selectedType}
					queryItems={[]} // TODO: Port queryItems logic to mentionTrait
					dynamicSearchResults={mentionTrait.fileSearchResults}
					isLoading={mentionTrait.searchLoading}
				/>
			)}
			{slashCommandTrait.showSlashCommandsMenu && (
				<SlashCommandMenu
					onSelect={(command: any) => slashCommandTrait.handleSlashCommandSelect(command, context)}
					searchQuery={slashCommandTrait.slashCommandsQuery}
					onMouseDown={() => {}}
					selectedIndex={slashCommandTrait.selectedSlashCommandsIndex}
					setSelectedIndex={slashCommandTrait.setSelectedSlashCommandsIndex}
				/>
			)}
		</>
	),
})
