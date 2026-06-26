import React, { useCallback, useRef, useState } from "react"
import {
	ContextMenuOptionType,
	getContextMenuOptionIndex,
	getContextMenuOptions,
	insertMention,
	removeMention,
	SearchResult,
	shouldShowContextMenu,
} from "@/shared/lib/context-mentions"
import { FileServiceClient } from "@/shared/api/grpc-client"
import { FileSearchRequest, FileSearchType } from "@shared/proto/dirac/file"
import { StringRequest } from "@shared/proto/dirac/common"
import { InputTrait, ModularInputContext } from "../types"
import { mentionRegex } from "@shared/context-mentions"

const DEFAULT_CONTEXT_MENU_OPTION = getContextMenuOptionIndex(ContextMenuOptionType.File)

export const useMentionTrait = (): InputTrait & {
	searchQuery: string
	selectedMenuIndex: number
	setSelectedMenuIndex: (index: number) => void
	fileSearchResults: SearchResult[]
	searchLoading: boolean
	selectedType: ContextMenuOptionType | null
	setSelectedType: (type: ContextMenuOptionType | null) => void
	showContextMenu: boolean
	setShowContextMenu: (show: boolean) => void
	handleMentionSelect: (type: ContextMenuOptionType, value?: string) => void
} => {
	const [showContextMenu, setShowContextMenu] = useState(false)
	const [searchQuery, setSearchQuery] = useState("")
	const [selectedMenuIndex, setSelectedMenuIndex] = useState(DEFAULT_CONTEXT_MENU_OPTION)
	const [fileSearchResults, setFileSearchResults] = useState<SearchResult[]>([])
	const [searchLoading, setSearchLoading] = useState(false)
	const [selectedType, setSelectedType] = useState<ContextMenuOptionType | null>(null)
	const [justDeletedSpaceAfterMention, setJustDeletedSpaceAfterMention] = useState(false)

	const searchTimeoutRef = useRef<NodeJS.Timeout | null>(null)
	const currentSearchQueryRef = useRef<string>("")

	const handleMentionSelect = useCallback((type: ContextMenuOptionType, value?: string, context?: ModularInputContext) => {
		if (!context) return

		const { inputValue, setInputValue, cursorPosition, setCursorPosition } = context

		if (type === ContextMenuOptionType.File || type === ContextMenuOptionType.Folder || type === ContextMenuOptionType.Git) {
			if (!value) {
				setSelectedType(type)
				return
			}
		}

		let insertValue = value || ""
		if (type === ContextMenuOptionType.Problems) {
			insertValue = "problems"
		} else if (type === ContextMenuOptionType.Terminal) {
			insertValue = "terminal"
		}

		const partialQueryLength = searchQuery.length

		const { newValue, mentionIndex } = insertMention(inputValue, cursorPosition, insertValue, partialQueryLength)

		setInputValue(newValue)
		setShowContextMenu(false)
		setSelectedType(null)
		setSearchQuery("")

		// Calculate new cursor position: after the inserted mention and the trailing space
		const newCursorPosition = newValue.indexOf(" ", mentionIndex + insertValue.length) + 1
		setCursorPosition(newCursorPosition)

		// Focus back to textarea
		setTimeout(() => {
			context.textAreaRef.current?.focus()
			context.textAreaRef.current?.setSelectionRange(newCursorPosition, newCursorPosition)
		}, 0)
	}, [])

	const onInputChange = (value: string, cursorPosition: number, context: ModularInputContext) => {
		const showMenu = shouldShowContextMenu(value, cursorPosition)
		setShowContextMenu(showMenu)

		if (showMenu) {
			const lastAtIndex = value.lastIndexOf("@", cursorPosition - 1)
			const query = value.slice(lastAtIndex + 1, cursorPosition)
			setSearchQuery(query)
			currentSearchQueryRef.current = query

			if (query.length > 0) {
				setSelectedMenuIndex(0)

				if (searchTimeoutRef.current) {
					clearTimeout(searchTimeoutRef.current)
				}

				setSearchLoading(true)

				const searchType =
					selectedType === ContextMenuOptionType.File
						? FileSearchType.FILE
						: selectedType === ContextMenuOptionType.Folder
							? FileSearchType.FOLDER
							: undefined

				let workspaceHint: string | undefined
				let actualSearchQuery = query
				const workspaceHintMatch = query.match(/^([\w-]+):\/(.*)$/)
				if (workspaceHintMatch) {
					workspaceHint = workspaceHintMatch[1]
					actualSearchQuery = workspaceHintMatch[2]
				}

				searchTimeoutRef.current = setTimeout(() => {
					if (selectedType === ContextMenuOptionType.Git || /^[a-f0-9]+$/i.test(actualSearchQuery)) {
						FileServiceClient.searchCommits(StringRequest.create({ value: actualSearchQuery || "" }))
							.then((results: any) => {
								const searchResults = (results.results || []) as SearchResult[]
								setFileSearchResults(searchResults)
								setSearchLoading(false)
							})
							.catch((error: any) => {
								console.error("Error searching commits:", error)
								setFileSearchResults([])
								setSearchLoading(false)
							})
					} else {
						FileServiceClient.searchFiles(
							FileSearchRequest.create({
								query: actualSearchQuery,
								mentionsRequestId: query,
								selectedType: searchType,
								workspaceHint: workspaceHint,
								prioritizeActiveFile: true,
							}),
						)
							.then((results: any) => {
								const searchResults = (results.results || []) as SearchResult[]
								setFileSearchResults(searchResults)
								setSearchLoading(false)

								if (searchResults.length === 0 && query.length > 0) {
									const options = getContextMenuOptions(query, selectedType, [], searchResults)
									const hasRealOptions = options.some(
										(opt) =>
											opt.type !== ContextMenuOptionType.NoResults &&
											opt.type !== ContextMenuOptionType.URL,
									)
									if (!hasRealOptions) {
										setShowContextMenu(false)
									}
								}
							})
							.catch((error: any) => {
								console.error("Error searching files:", error)
								setFileSearchResults([])
								setSearchLoading(false)
								setShowContextMenu(false)
							})
					}
				}, 200)
			} else {
				setSelectedMenuIndex(DEFAULT_CONTEXT_MENU_OPTION)
			}
		} else {
			setSearchQuery("")
			setSelectedMenuIndex(-1)
			setFileSearchResults([])
		}
	}

	const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>, context: ModularInputContext) => {
		if (showContextMenu) {
			const options = getContextMenuOptions(searchQuery, selectedType, [], fileSearchResults)

			if (e.key === "Escape") {
				setShowContextMenu(false)
				setSearchQuery("")
				return true
			}

			if (e.key === "ArrowUp" || e.key === "ArrowDown") {
				e.preventDefault()
				const direction = e.key === "ArrowUp" ? -1 : 1
				const selectableOptions = options.filter(
					(opt) => opt.type !== ContextMenuOptionType.NoResults && opt.type !== ContextMenuOptionType.URL,
				)

				if (selectableOptions.length === 0) return true

				let nextIndex = selectedMenuIndex + direction
				if (nextIndex < 0) nextIndex = options.length - 1
				if (nextIndex >= options.length) nextIndex = 0

				// Skip non-selectable options
				while (
					options[nextIndex].type === ContextMenuOptionType.NoResults ||
					options[nextIndex].type === ContextMenuOptionType.URL
				) {
					nextIndex += direction
					if (nextIndex < 0) nextIndex = options.length - 1
					if (nextIndex >= options.length) nextIndex = 0
				}

				setSelectedMenuIndex(nextIndex)
				return true
			}

			if ((e.key === "Enter" || e.key === "Tab") && selectedMenuIndex !== -1) {
				const selectedOption = options[selectedMenuIndex]
				if (
					selectedOption &&
					selectedOption.type !== ContextMenuOptionType.NoResults &&
					selectedOption.type !== ContextMenuOptionType.URL
				) {
					e.preventDefault()
					const mentionValue = selectedOption.label?.includes(":") ? selectedOption.label : selectedOption.value
					handleMentionSelect(selectedOption.type, mentionValue, context)
					return true
				}
			}
		}

		// Handle backspace for mention deletion
		if (e.key === "Backspace") {
			const { inputValue, cursorPosition, setInputValue, setCursorPosition } = context
			const charBeforeCursor = inputValue[cursorPosition - 1]
			const charAfterCursor = inputValue[cursorPosition]
			const charBeforeIsWhitespace = !charBeforeCursor || /\s/.test(charBeforeCursor)

			if (charBeforeIsWhitespace && inputValue.slice(0, cursorPosition - 1).match(new RegExp(mentionRegex.source + "$"))) {
				if (!/\s/.test(charAfterCursor || "")) {
					e.preventDefault()
					const newCursorPosition = cursorPosition - 1
					setCursorPosition(newCursorPosition)
					setJustDeletedSpaceAfterMention(true)
					return true
				}
				setJustDeletedSpaceAfterMention(true)
			} else if (justDeletedSpaceAfterMention) {
				const { newText, newPosition } = removeMention(inputValue, cursorPosition)
				if (newText !== inputValue) {
					e.preventDefault()
					setInputValue(newText)
					setCursorPosition(newPosition)
					setTimeout(() => {
						context.textAreaRef.current?.setSelectionRange(newPosition, newPosition)
					}, 0)
				}
				setJustDeletedSpaceAfterMention(false)
				setShowContextMenu(false)
				return true
			} else {
				setJustDeletedSpaceAfterMention(false)
			}
		}

		return false
	}

	return {
		id: "mention",
		searchQuery,
		selectedMenuIndex,
		setSelectedMenuIndex,
		fileSearchResults,
		searchLoading,
		selectedType,
		setSelectedType,
		showContextMenu,
		setShowContextMenu,
		handleMentionSelect,
		onInputChange,
		onKeyDown,
	}
}
