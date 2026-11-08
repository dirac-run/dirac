import { ModelInfo } from "@shared/api"
import { VSCodeTextField } from "@vscode/webview-ui-toolkit/react"
import Fuse from "fuse.js"
import { KeyboardEvent, useEffect, useId, useMemo, useRef, useState } from "react"
import styled from "styled-components"
import { Button } from "@/shared/ui/button"
import { Input } from "@/shared/ui/input"
import { Popover, PopoverContent, PopoverTrigger } from "@/shared/ui/popover"
import { highlight } from "../../../history/components/HistoryView/HistoryView"

interface ModelAutocompleteProps {
	models: Record<string, ModelInfo>
	selectedModelId: string | undefined
	onChange: (modelId: string, modelInfo: ModelInfo | undefined) => void
	zIndex?: number
	label?: string
	placeholder?: string
	allowCustomModelId?: boolean
	compact?: boolean
}

const AUTOCOMPLETE_Z_INDEX = 1_000

export const ModelAutocomplete = ({
	models,
	selectedModelId,
	onChange,
	zIndex = AUTOCOMPLETE_Z_INDEX,
	label = "Model",
	placeholder = "Search and select a model...",
	allowCustomModelId = true,
	compact = false,
}: ModelAutocompleteProps) => {
	const [searchTerm, setSearchTerm] = useState(selectedModelId || "")
	const [isDropdownVisible, setIsDropdownVisible] = useState(false)
	const [selectedIndex, setSelectedIndex] = useState(-1)
	const dropdownRef = useRef<HTMLDivElement>(null)
	const itemRefs = useRef<(HTMLDivElement | null)[]>([])
	const dropdownListRef = useRef<HTMLDivElement>(null)
	const isSelectingRef = useRef(false) // Track if user is clicking a dropdown item
	const compactInputRef = useRef<HTMLInputElement>(null)

	// Generate unique IDs for accessibility
	const uniqueId = useId()
	const inputId = `model-autocomplete-${uniqueId}`
	const listboxId = `model-listbox-${uniqueId}`

	useEffect(() => {
		setSearchTerm(selectedModelId || "")
	}, [selectedModelId])

	useEffect(() => {
		if (compact) return // Radix owns dismissal for the portalled compact popup.
		const handleClickOutside = (event: MouseEvent) => {
			if (dropdownRef.current && !dropdownRef.current.contains(event.target as Node)) {
				setIsDropdownVisible(false)
			}
		}

		document.addEventListener("mousedown", handleClickOutside)
		return () => {
			document.removeEventListener("mousedown", handleClickOutside)
		}
	}, [compact])

	const modelIds = useMemo(() => {
		return Object.keys(models).sort((a, b) => a.localeCompare(b))
	}, [models])

	const searchableItems = useMemo(() => {
		return modelIds.map((id) => ({
			id,
			html: id,
		}))
	}, [modelIds])

	const fuse = useMemo(() => {
		return new Fuse(searchableItems, {
			keys: ["html"],
			threshold: 0.6,
			shouldSort: true,
			isCaseSensitive: false,
			ignoreLocation: false,
			includeMatches: true,
			minMatchCharLength: 1,
		})
	}, [searchableItems])

	const modelSearchResults = useMemo(() => {
		if (!searchTerm) {
			return searchableItems
		}
		return highlight(fuse.search(searchTerm), "model-item-highlight")
	}, [searchableItems, searchTerm, fuse])

	const handleModelChange = (newModelId: string) => {
		if (!allowCustomModelId && !Object.hasOwn(models, newModelId)) return
		if (!newModelId.trim()) return
		setSearchTerm(newModelId)
		const modelInfo = models[newModelId]
		onChange(newModelId, modelInfo)
	}

	const handleKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
		if (!isDropdownVisible) {
			return
		}

		switch (event.key) {
			case "ArrowDown":
				event.preventDefault()
				setSelectedIndex((prev) => (prev < modelSearchResults.length - 1 ? prev + 1 : prev))
				break
			case "ArrowUp":
				event.preventDefault()
				setSelectedIndex((prev) => (prev > 0 ? prev - 1 : prev))
				break
			case "Enter":
				event.preventDefault()
				if (selectedIndex >= 0 && selectedIndex < modelSearchResults.length) {
					handleModelChange(modelSearchResults[selectedIndex].id)
					setIsDropdownVisible(false)
				} else {
					// User typed a custom model ID
					handleModelChange(searchTerm)
					setIsDropdownVisible(false)
				}
				break
			case "Escape":
				setIsDropdownVisible(false)
				setSelectedIndex(-1)
				break
		}
	}

	// Reset selection when search term changes
	useEffect(() => {
		setSelectedIndex(-1)
		if (dropdownListRef.current) {
			dropdownListRef.current.scrollTop = 0
		}
	}, [searchTerm])

	// Scroll selected item into view
	useEffect(() => {
		if (selectedIndex >= 0 && itemRefs.current[selectedIndex]) {
			itemRefs.current[selectedIndex]?.scrollIntoView({
				block: "nearest",
				behavior: "smooth",
			})
		}
	}, [selectedIndex])

	const activeDescendantId = selectedIndex >= 0 ? `${listboxId}-option-${selectedIndex}` : undefined

	if (compact) {
		const customModelId = searchTerm.trim()
		const showCustomOption = allowCustomModelId && customModelId.length > 0 && !Object.hasOwn(models, customModelId)
		const options = [
			...modelSearchResults.map((item) => ({ id: item.id, custom: false })),
			...(showCustomOption ? [{ id: customModelId, custom: true }] : []),
		]
		const setCompactOpen = (open: boolean) => {
			setIsDropdownVisible(open)
			setSelectedIndex(-1)
			setSearchTerm("")
		}
		const selectCompactModel = (modelId: string) => {
			if (!modelId.trim() || (!allowCustomModelId && !Object.hasOwn(models, modelId))) return
			if (modelId !== selectedModelId) onChange(modelId, models[modelId])
			setCompactOpen(false)
		}
		const onCompactKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
			if (event.nativeEvent.isComposing) return
			switch (event.key) {
				case "ArrowDown":
					event.preventDefault()
					setSelectedIndex((index) => Math.min(index + 1, options.length - 1))
					break
				case "ArrowUp":
					event.preventDefault()
					setSelectedIndex((index) => (index < 0 ? options.length - 1 : Math.max(0, index - 1)))
					break
				case "Enter":
					event.preventDefault()
					if (options[selectedIndex]) selectCompactModel(options[selectedIndex].id)
					else if (customModelId) selectCompactModel(customModelId)
					break
			}
			// Escape and outside interactions are dismissed by Radix, without committing the query.
		}

		return (
			<Popover onOpenChange={setCompactOpen} open={isDropdownVisible}>
				<PopoverTrigger asChild>
					<Button
						aria-label={`${label}: ${selectedModelId || "Select a model"}`}
						className="h-7 w-fit min-w-0 max-w-[220px] shrink gap-1 rounded-sm px-2 py-0 text-xs font-normal"
						onKeyDown={(event) => {
							if (event.key === "ArrowDown" || event.key === "ArrowUp") {
								event.preventDefault()
								setCompactOpen(true)
							}
						}}
						style={{
							backgroundColor: "var(--vscode-dropdown-background)",
							color: "var(--vscode-dropdown-foreground)",
							borderColor: "var(--vscode-dropdown-border, var(--vscode-input-border, transparent))",
						}}
						title={selectedModelId || placeholder}
						type="button"
						variant="outline">
						<span className="min-w-0 truncate">{selectedModelId || "Select a model"}</span>
						<span aria-hidden="true" className="codicon codicon-chevron-down shrink-0" />
					</Button>
				</PopoverTrigger>
				<PopoverContent
					align="start"
					aria-label={`${label} selection`}
					className="flex flex-col gap-2 p-2"
					collisionPadding={8}
					onOpenAutoFocus={(event) => {
						event.preventDefault()
						compactInputRef.current?.focus()
					}}
					style={{
						width: 360,
						maxWidth: "calc(100vw - 16px)",
						maxHeight: "var(--radix-popover-content-available-height)",
						backgroundColor: "var(--vscode-dropdown-background)",
						color: "var(--vscode-dropdown-foreground)",
						borderColor: "var(--vscode-dropdown-border, var(--vscode-input-border, transparent))",
						zIndex,
					}}>
					<Input
						aria-activedescendant={options[selectedIndex] ? activeDescendantId : undefined}
						aria-autocomplete="list"
						aria-controls={listboxId}
						aria-expanded={isDropdownVisible}
						aria-label={`Search ${label}`}
						className="h-7 shrink-0 rounded-sm px-2 py-0 text-xs"
						onChange={(event) => setSearchTerm(event.target.value)}
						onKeyDown={onCompactKeyDown}
						placeholder={placeholder}
						ref={compactInputRef}
						role="combobox"
						value={searchTerm}
					/>
					<div aria-label={`${label} suggestions`} className="min-h-0 max-h-60 overflow-y-auto" id={listboxId} ref={dropdownListRef} role="listbox">
						{options.map((item, index) => (
							<DropdownItem
								aria-selected={selectedModelId === item.id}
								id={`${listboxId}-option-${index}`}
								isSelected={index === selectedIndex}
								key={item.id}
								onClick={() => selectCompactModel(item.id)}
								onMouseDown={(event) => event.preventDefault()}
								onMouseEnter={() => setSelectedIndex(index)}
								ref={(element) => { itemRefs.current[index] = element }}
								role="option"
								style={{ color: index === selectedIndex ? "var(--vscode-list-activeSelectionForeground)" : undefined }}>
								{item.custom ? `Use custom model: ${item.id}` : item.id}
							</DropdownItem>
						))}
					</div>
					{options.length === 0 && <div className="px-2 text-xs" role="status">No matching models</div>}
				</PopoverContent>
			</Popover>
		)
	}

	return (
		<div style={{ width: "100%", paddingBottom: 2 }}>
			<style>
				{`
				.model-item-highlight {
					background-color: var(--vscode-editor-findMatchHighlightBackground);
					color: inherit;
				}
				`}
			</style>
			<div style={{ display: "flex", flexDirection: "column" }}>
				<label htmlFor={inputId}>
					<span style={{ fontWeight: 500 }}>{label}</span>
				</label>

				<DropdownWrapper ref={dropdownRef}>
					<VSCodeTextField
						aria-activedescendant={activeDescendantId}
						aria-autocomplete="list"
						aria-controls={isDropdownVisible ? listboxId : undefined}
						aria-expanded={isDropdownVisible}
						id={inputId}
						onBlur={() => {
							// Delay to allow click events on dropdown items to fire first
							setTimeout(() => {
								if (!isSelectingRef.current && searchTerm !== selectedModelId) {
									handleModelChange(searchTerm)
								}
								isSelectingRef.current = false
							}, 150)
						}}
						onFocus={() => setIsDropdownVisible(true)}
						onInput={(e) => {
							setSearchTerm((e.target as HTMLInputElement)?.value || "")
							setIsDropdownVisible(true)
						}}
						onKeyDown={handleKeyDown}
						placeholder={placeholder}
						role="combobox"
						style={{
							width: "100%",
							zIndex: zIndex,
							position: "relative",
						}}
						value={searchTerm}>
						{searchTerm && (
							<div
								aria-label="Clear search"
								className="input-icon-button codicon codicon-close"
								onClick={() => {
									setSearchTerm("")
									setIsDropdownVisible(true)
								}}
								slot="end"
								style={{
									display: "flex",
									justifyContent: "center",
									alignItems: "center",
									height: "100%",
								}}
							/>
						)}
					</VSCodeTextField>
					{isDropdownVisible && (
						<DropdownList
							aria-label="Model suggestions"
							id={listboxId}
							ref={dropdownListRef}
							role="listbox"
							style={{ zIndex: zIndex - 1 }}>
							{modelSearchResults.map((item, index) => (
								<DropdownItem
									aria-selected={index === selectedIndex}
									id={`${listboxId}-option-${index}`}
									isSelected={index === selectedIndex}
									key={item.id}
									onClick={() => {
										handleModelChange(item.id)
										setIsDropdownVisible(false)
										isSelectingRef.current = false
									}}
									onMouseDown={() => {
										isSelectingRef.current = true
									}}
									onMouseEnter={() => setSelectedIndex(index)}
									ref={(el) => (itemRefs.current[index] = el)}
									role="option">
									<span dangerouslySetInnerHTML={{ __html: item.html }} />
								</DropdownItem>
							))}
						</DropdownList>
					)}
				</DropdownWrapper>
			</div>
		</div>
	)
}

const DropdownWrapper = styled.div`
	position: relative;
	width: 100%;
`

const DropdownList = styled.div`
	position: absolute;
	top: calc(100% - 3px);
	left: 0;
	width: calc(100% - 2px);
	max-height: 200px;
	overflow-y: auto;
	background-color: var(--vscode-dropdown-background);
	border: 1px solid var(--vscode-list-activeSelectionBackground);
	border-bottom-left-radius: 3px;
	border-bottom-right-radius: 3px;
`

const DropdownItem = styled.div<{ isSelected: boolean }>`
	padding: 5px 10px;
	cursor: pointer;
	word-break: break-all;
	white-space: normal;

	background-color: ${({ isSelected }) => (isSelected ? "var(--vscode-list-activeSelectionBackground)" : "inherit")};

	&:hover {
		background-color: var(--vscode-list-activeSelectionBackground);
	}
`
