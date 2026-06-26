import React, { useCallback, useState } from "react"
import {
	getMatchingSlashCommands,
	insertSlashCommand,
	removeSlashCommand,
	shouldShowSlashCommandsMenu,
	slashCommandDeleteRegex,
} from "@/shared/lib/slash-commands"
import { useSettingsStore } from "@/features/settings/store/settingsStore"
import { InputTrait, ModularInputContext } from "../types"

export const useSlashCommandTrait = (): InputTrait & {
	slashCommandsQuery: string
	selectedSlashCommandsIndex: number
	setSelectedSlashCommandsIndex: (index: number) => void
	showSlashCommandsMenu: boolean
	setShowSlashCommandsMenu: (show: boolean) => void
	handleSlashCommandSelect: (command: any) => void
} => {
	const [showSlashCommandsMenu, setShowSlashCommandsMenu] = useState(false)
	const [slashCommandsQuery, setSlashCommandsQuery] = useState("")
	const [selectedSlashCommandsIndex, setSelectedSlashCommandsIndex] = useState(0)

	const availableSkills = useSettingsStore((state: any) => state.availableSkills)
	const localWorkflowToggles = useSettingsStore((state: any) => state.localWorkflowToggles)
	const globalWorkflowToggles = useSettingsStore((state: any) => state.globalWorkflowToggles)
	const remoteWorkflowToggles = useSettingsStore((state: any) => state.remoteWorkflowToggles)
	const remoteWorkflows = useSettingsStore((state: any) => state.remoteWorkflows)
	const handleSlashCommandSelect = useCallback(
		(command: any, context?: ModularInputContext) => {
			if (!context) return

			const { inputValue, setInputValue, cursorPosition, setCursorPosition } = context

			const partialCommandLength = slashCommandsQuery.length

			const { newValue, commandIndex } = insertSlashCommand(inputValue, command.name, partialCommandLength, cursorPosition)

			setInputValue(newValue)
			setShowSlashCommandsMenu(false)
			setSlashCommandsQuery("")

			// Calculate new cursor position: after the inserted command and the trailing space
			const newCursorPosition = newValue.indexOf(" ", commandIndex + 1 + command.name.length) + 1
			setCursorPosition(newCursorPosition)

			// Focus back to textarea
			setTimeout(() => {
				context.textAreaRef.current?.focus()
				context.textAreaRef.current?.setSelectionRange(newCursorPosition, newCursorPosition)
			}, 0)
		},
		[slashCommandsQuery],
	)

	const onInputChange = (value: string, cursorPosition: number, context: ModularInputContext) => {
		const showMenu = shouldShowSlashCommandsMenu(value, cursorPosition)
		setShowSlashCommandsMenu(showMenu)

		if (showMenu) {
			const beforeCursor = value.slice(0, cursorPosition)
			const slashIndex = beforeCursor.lastIndexOf("/")
			const query = value.slice(slashIndex + 1, cursorPosition)
			setSlashCommandsQuery(query)
			setSelectedSlashCommandsIndex(0)
		} else {
			setSlashCommandsQuery("")
			setSelectedSlashCommandsIndex(0)
		}
	}

	const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>, context: ModularInputContext) => {
		if (showSlashCommandsMenu) {
			const matchingCommands = getMatchingSlashCommands(
				slashCommandsQuery,
				localWorkflowToggles,
				globalWorkflowToggles,
				remoteWorkflowToggles,
				remoteWorkflows,
				availableSkills,
			)

			if (e.key === "Escape") {
				setShowSlashCommandsMenu(false)
				setSlashCommandsQuery("")
				return true
			}

			if (e.key === "ArrowUp" || e.key === "ArrowDown") {
				e.preventDefault()
				const direction = e.key === "ArrowUp" ? -1 : 1
				const totalCommands = matchingCommands.length

				if (totalCommands === 0) return true

				let nextIndex = selectedSlashCommandsIndex + direction
				if (nextIndex < 0) nextIndex = totalCommands - 1
				if (nextIndex >= totalCommands) nextIndex = 0

				setSelectedSlashCommandsIndex(nextIndex)
				return true
			}

			if ((e.key === "Enter" || e.key === "Tab") && selectedSlashCommandsIndex !== -1) {
				const selectedCommand = matchingCommands[selectedSlashCommandsIndex]
				if (selectedCommand) {
					e.preventDefault()
					handleSlashCommandSelect(selectedCommand, context)
					return true
				}
			}
		}

		// Handle backspace for slash command deletion
		if (e.key === "Backspace") {
			const { inputValue, cursorPosition, setInputValue, setCursorPosition } = context
			const charBeforeCursor = inputValue[cursorPosition - 1]
			const charAfterCursor = inputValue[cursorPosition]
			const charBeforeIsWhitespace = !charBeforeCursor || /\s/.test(charBeforeCursor)

			if (charBeforeIsWhitespace && inputValue.slice(0, cursorPosition - 1).match(slashCommandDeleteRegex)) {
				if (!/\s/.test(charAfterCursor || "")) {
					e.preventDefault()
					const newCursorPosition = cursorPosition - 1
					setCursorPosition(newCursorPosition)
					return true
				}
			} else {
				// Check if we just deleted the space after a slash command
				// This part is a bit tricky without the `justDeletedSpaceAfterSlashCommand` state
				// For now, we'll rely on the `removeSlashCommand` logic if it matches
				const { newText, newPosition } = removeSlashCommand(inputValue, cursorPosition)
				if (newText !== inputValue) {
					e.preventDefault()
					setInputValue(newText)
					setCursorPosition(newPosition)
					setTimeout(() => {
						context.textAreaRef.current?.setSelectionRange(newPosition, newPosition)
					}, 0)
					setShowSlashCommandsMenu(false)
					return true
				}
			}
		}

		return false
	}

	return {
		id: "slash-command",
		slashCommandsQuery,
		selectedSlashCommandsIndex,
		setSelectedSlashCommandsIndex,
		showSlashCommandsMenu,
		setShowSlashCommandsMenu,
		handleSlashCommandSelect,
		onInputChange,
		onKeyDown,
	}
}
