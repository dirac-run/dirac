import React, { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { useMenuAnnouncement } from "@/shared/hooks/useMenuAnnouncement"
import { ContextMenuOptionType, ContextMenuQueryItem, getContextMenuOptions, SearchResult } from "@/shared/lib/context-mentions"
import ScreenReaderAnnounce from "@/shared/ui/ScreenReaderAnnounce"

interface ContextMenuProps {
	onSelect: (type: ContextMenuOptionType, value?: string) => void
	searchQuery: string
	onMouseDown: (e: React.MouseEvent) => void
	selectedIndex: number
	setSelectedIndex: (index: number) => void
	selectedType: ContextMenuOptionType | null
	queryItems: ContextMenuQueryItem[]
	dynamicSearchResults?: SearchResult[]
	isLoading?: boolean
}

const ContextMenu: React.FC<ContextMenuProps> = ({
	onSelect,
	searchQuery,
	onMouseDown,
	selectedIndex,
	setSelectedIndex,
	selectedType,
	queryItems,
	dynamicSearchResults = [],
	isLoading = false,
}) => {
	const menuRef = useRef<HTMLDivElement>(null)

	// State to show delayed loading indicator
	const [showDelayedLoading, setShowDelayedLoading] = useState(false)
	const loadingTimeoutRef = useRef<NodeJS.Timeout | null>(null)

	const filteredOptions = useMemo(() => {
		const options = getContextMenuOptions(searchQuery, selectedType, queryItems, dynamicSearchResults)
		return options
	}, [searchQuery, selectedType, queryItems, dynamicSearchResults])

	// Effect to handle delayed loading indicator (show "Searching..." after 500ms of searching)
	useEffect(() => {
		if (loadingTimeoutRef.current) {
			clearTimeout(loadingTimeoutRef.current)
			loadingTimeoutRef.current = null
		}

		if (isLoading && searchQuery) {
			setShowDelayedLoading(false)
			loadingTimeoutRef.current = setTimeout(() => {
				if (isLoading) {
					setShowDelayedLoading(true)
				}
			}, 500)
		} else {
			setShowDelayedLoading(false)
		}

		return () => {
			if (loadingTimeoutRef.current) {
				clearTimeout(loadingTimeoutRef.current)
				loadingTimeoutRef.current = null
			}
		}
	}, [isLoading, searchQuery])

	useEffect(() => {
		if (menuRef.current) {
			const selectedElement = menuRef.current.children[selectedIndex] as HTMLElement
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

	const SIMPLE_OPTION_LABELS: Partial<Record<ContextMenuOptionType, string>> = {
		[ContextMenuOptionType.Problems]: "Problems",
		[ContextMenuOptionType.Terminal]: "Terminal",
		[ContextMenuOptionType.URL]: "Paste URL to fetch contents",
		[ContextMenuOptionType.NoResults]: "No results found",
	}

	const getOptionLabel = useCallback((option: ContextMenuQueryItem): string => {
		const simpleLabel = SIMPLE_OPTION_LABELS[option.type]
		if (simpleLabel) {
			return simpleLabel
		}

		switch (option.type) {
			case ContextMenuOptionType.Git:
				if (option.value) {
					return `${option.label}${option.description ? `, ${option.description}` : ""}`
				}
				return "Git Commits"
			case ContextMenuOptionType.File:
			case ContextMenuOptionType.Folder:
				if (option.value) {
					return option.label || option.value
				}
				return `Add ${option.type === ContextMenuOptionType.File ? "File" : "Folder"}`
			default:
				return option.label || option.value || ""
		}
	}, [])

	const renderOptionContent = (option: ContextMenuQueryItem) => {
		const simpleLabel = SIMPLE_OPTION_LABELS[option.type]
		if (simpleLabel) {
			return <span>{simpleLabel}</span>
		}

		switch (option.type) {
			case ContextMenuOptionType.Git:
				if (option.value) {
					return (
						<div className="flex flex-col gap-0">
							<span className="ph-no-capture leading-[1.2]">{option.label}</span>
							<span className="ph-no-capture text-[0.85em] opacity-70 whitespace-nowrap overflow-hidden text-ellipsis leading-[1.2]">
								{option.description}
							</span>
						</div>
					)
				}
				return <span>Git Commits</span>
			case ContextMenuOptionType.File:
			case ContextMenuOptionType.Folder:
				if (option.value) {
					const displayText =
						option.label && option.label !== option.value.split("/").pop() ? option.label : option.value

					return (
						<>
							<span className="ph-no-capture whitespace-nowrap overflow-hidden text-ellipsis">{displayText}</span>
							{option.description && (
								<span className="ph-no-capture text-[0.85em] opacity-70 whitespace-nowrap overflow-hidden text-ellipsis">
									{option.description}
								</span>
							)}
						</>
					)
				}
				return <span>Add {option.type === ContextMenuOptionType.File ? "File" : "Folder"}</span>
			default:
				return <span>{option.label || option.value}</span>
		}
	}

	const getIconForOption = (option: ContextMenuQueryItem) => {
		switch (option.type) {
			case ContextMenuOptionType.File:
				return "file"
			case ContextMenuOptionType.Folder:
				return "folder"
			case ContextMenuOptionType.Problems:
				return "warning"
			case ContextMenuOptionType.Terminal:
				return "terminal"
			case ContextMenuOptionType.URL:
				return "link"
			case ContextMenuOptionType.Git:
				return "git-commit"
			case ContextMenuOptionType.NoResults:
				return "info"
			default:
				return "file"
		}
	}

	const isOptionSelectable = (option: ContextMenuQueryItem): boolean => {
		return option.type !== ContextMenuOptionType.NoResults && option.type !== ContextMenuOptionType.URL
	}

	const { announcement } = useMenuAnnouncement({
		items: filteredOptions,
		selectedIndex,
		getItemLabel: getOptionLabel,
		isItemSelectable: isOptionSelectable,
	})

	const handleSelect = useCallback(
		(option: ContextMenuQueryItem) => {
			if (isOptionSelectable(option)) {
				const mentionValue = option.label?.includes(":") ? option.label : option.value
				onSelect(option.type, mentionValue)
			}
		},
		[onSelect],
	)

	return (
		<div
			className="absolute bottom-[calc(100%-10px)] left-[15px] right-[15px] overflow-x-hidden z-1000"
			onMouseDown={onMouseDown}>
			<ScreenReaderAnnounce message={announcement} />
			<div
				aria-activedescendant={
					filteredOptions.length > selectedIndex &&
					selectedIndex > -1 &&
					isOptionSelectable(filteredOptions[selectedIndex])
						? `context-menu-item-${selectedIndex}`
						: undefined
				}
				aria-label="Context mentions"
				ref={menuRef}
				role="listbox"
				className="bg-(--vscode-dropdown-background) border border-(--vscode-editorGroup-border) rounded-[3px] shadow-[0_4px_10px_rgba(0,0,0,0.25)] z-1000 flex flex-col max-h-[200px] overflow-y-auto overscroll-contain">
				{showDelayedLoading && searchQuery && (
					<div className="px-3 py-2 flex items-center gap-2 opacity-70">
						<i className="codicon codicon-loading codicon-modifier-spin text-[14px]" />
						<span>Searching...</span>
					</div>
				)}
				{filteredOptions.map((option, index) => {
					const workspacePrefix = option.workspaceName ? `${option.workspaceName}:` : ""
					const generatedKey = `${option.type}-${workspacePrefix}${option.value || index}`
					const isSelectable = isOptionSelectable(option)
					const isSelected = index === selectedIndex && isSelectable

					return (
						<div
							aria-label={getOptionLabel(option)}
							aria-selected={isSelected}
							className={`py-2 px-3 flex items-center justify-between border-b border-(--vscode-editorGroup-border) ${
								isSelectable ? "cursor-pointer" : "cursor-default"
							} ${
								isSelected
									? "bg-(--vscode-quickInputList-focusBackground) text-(--vscode-quickInputList-focusForeground)"
									: ""
							}`}
							id={`context-menu-item-${index}`}
							key={generatedKey}
							onClick={() => handleSelect(option)}
							onMouseEnter={() => isSelectable && setSelectedIndex(index)}
							role="option">
							<div className="flex items-center flex-1 min-w-0 overflow-hidden">
								<i className={`codicon codicon-${getIconForOption(option)} mr-2 flex-shrink-0 text-[14px]`} />
								{renderOptionContent(option)}
							</div>
							{(option.type === ContextMenuOptionType.File ||
								option.type === ContextMenuOptionType.Folder ||
								option.type === ContextMenuOptionType.Git) &&
								!option.value && <i className="codicon codicon-chevron-right text-[14px] flex-shrink-0 ml-2" />}
							{(option.type === ContextMenuOptionType.Problems ||
								option.type === ContextMenuOptionType.Terminal ||
								((option.type === ContextMenuOptionType.File ||
									option.type === ContextMenuOptionType.Folder ||
									option.type === ContextMenuOptionType.Git) &&
									option.value)) && <i className="codicon codicon-add text-[14px] flex-shrink-0 ml-2" />}
						</div>
					)
				})}
			</div>
		</div>
	)
}

export default ContextMenu
