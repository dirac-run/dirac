import { Box, Text } from "ink"
import React from "react"
import wrapAnsi from "wrap-ansi"
import { useTerminalSize } from "../../hooks/useTerminalSize"
import { theme } from "../../constants/theme"
import { Checkbox } from "../Checkbox"
import { SettingsItemType, type ListItem } from "./types"

interface SettingsListViewProps {
	items: ListItem[]
	selectedIndex: number
	maxRows: number
}

const HelpText = ({ item }: { item: ListItem }) => {
	const color = item.helpTone === "error" ? theme.error : item.helpTone === "warning" ? theme.warning : theme.muted
	return (
		<Box marginLeft={item.isSubItem ? 8 : 6}>
			<Text color={color}>{item.description}</Text>
		</Box>
	)
}

export const estimateItemRows = (item: ListItem, isSelected: boolean, width: number): number => {
	const textRows = (text: string, indent = 0) => wrapAnsi(text, Math.max(1, width - indent), { hard: true, trim: false }).split("\n").length
	if ([SettingsItemType.SPACER, SettingsItemType.SEPARATOR].includes(item.type)) return 1
	if (item.type === SettingsItemType.HEADER) return textRows(item.label)
	const value = item.type === SettingsItemType.OBJECT ? "{...}" : String(item.value)
	const content = item.type === SettingsItemType.CHECKBOX ? `  [ ] ${item.label}` : `  ${item.label}${item.label && value !== "" ? ": " : ""}${value}`
	let rows = textRows(content, item.type === SettingsItemType.CHECKBOX && item.isSubItem ? 2 : 0)
	const helpIndent = item.isSubItem ? 8 : 6
	if (isSelected && item.description) rows += textRows(item.description, helpIndent)
	if (item.persistentHelp && (item.alwaysShowHelp || isSelected || Boolean(item.value))) rows += textRows(item.persistentHelp, helpIndent)
	return rows
}

const getVisibleSettingsWindow = (items: ListItem[], selectedIndex: number, maxRows: number, width: number) => {
	let start = selectedIndex
	let end = selectedIndex + 1
	let usedRows = estimateItemRows(items[selectedIndex]!, true, width)
	while (start > 0 || end < items.length) {
		if (end < items.length) {
			const rows = estimateItemRows(items[end]!, false, width)
			if (usedRows + rows <= maxRows) {
				usedRows += rows
				end += 1
				continue
			}
		}
		if (start > 0) {
			const rows = estimateItemRows(items[start - 1]!, false, width)
			if (usedRows + rows <= maxRows) {
				usedRows += rows
				start -= 1
				continue
			}
		}
		break
	}
	return { start, end }
}
export const SettingsListView: React.FC<SettingsListViewProps> = ({ items, selectedIndex, maxRows }) => {
	const { columns } = useTerminalSize()
	const { start: visibleStart, end: visibleEnd } = getVisibleSettingsWindow(items, selectedIndex, Math.max(1, maxRows - 2), columns - 4)
	const visibleCount = visibleEnd - visibleStart
	const showTopIndicator = visibleStart > 0
	const showBottomIndicator = visibleEnd < items.length
	const visibleItems = items.slice(visibleStart, visibleEnd)
	return (
		<Box flexDirection="column" flexShrink={0}>
			{showTopIndicator && <Text color={theme.muted}>… {visibleStart} more above</Text>}
			{visibleItems.map((item, visibleIndex) => {
				const idx = visibleStart + visibleIndex
				const isSelected = idx === selectedIndex
				if (item.type === SettingsItemType.HEADER) {
					return (
						<Text bold color={theme.text} key={item.key}>
							{item.label}
						</Text>
					)
				}
				if (item.type === SettingsItemType.SPACER) return <Box key={item.key} marginTop={1} />
				if (item.type === SettingsItemType.SEPARATOR) {
					return (
						<Box
							borderBottom={false}
							borderColor={theme.border}
							borderDimColor
							borderLeft={false}
							borderRight={false}
							borderStyle="single"
							borderTop
							key={item.key}
							width="100%"
						/>
					)
				}

				let row: React.ReactNode
				if (item.type === SettingsItemType.CHECKBOX) {
					row = (
						<Box marginLeft={item.isSubItem ? 2 : 0}>
							<Checkbox checked={Boolean(item.value)} isSelected={isSelected} label={item.label} />
						</Box>
					)
				} else if (item.type === SettingsItemType.ACTION) {
					row = (
						<Text>
							<Text bold color={isSelected ? theme.primary : theme.subtle}>
								{isSelected ? "❯" : " "}{" "}
							</Text>
							<Text bold={isSelected} color={isSelected ? theme.strongText : theme.text}>
								{item.label}
							</Text>
							{item.value !== "" && <Text color={theme.primary}>: {String(item.value)}</Text>}
						</Text>
					)
				} else if (item.type === SettingsItemType.CYCLE) {
					row = (
						<Text>
							<Text bold color={isSelected ? theme.primary : theme.subtle}>
								{isSelected ? "❯" : " "}{" "}
							</Text>
							<Text bold={isSelected} color={isSelected ? theme.strongText : theme.text}>
								{item.label}:{" "}
							</Text>
							<Text color={theme.primary}>{String(item.value)}</Text>
						</Text>
					)
				} else {
					row = (
						<Text>
							<Text bold color={isSelected ? theme.primary : theme.subtle}>
								{isSelected ? "❯" : " "}{" "}
							</Text>
							{item.label && (
								<Text bold={isSelected} color={isSelected ? theme.strongText : theme.text}>
									{item.label}:{" "}
								</Text>
							)}
							<Text color={item.type === SettingsItemType.READONLY ? theme.muted : theme.primary}>
								{typeof item.value === "string"
									? item.value
									: item.type === SettingsItemType.OBJECT
										? "{...}"
										: String(item.value)}
							</Text>
						</Text>
					)
				}

				const showSelectedHelp = isSelected && item.description
				const showPersistentHelp = item.persistentHelp && (item.alwaysShowHelp || isSelected || Boolean(item.value))
				return (
					<Box flexDirection="column" flexShrink={0} key={item.key}>
						{row}
						{showSelectedHelp && <HelpText item={item} />}
						{showPersistentHelp && (
							<Box marginLeft={item.isSubItem ? 8 : 6}>
								<Text color={item.helpTone === "error" ? theme.error : theme.warning}>{item.persistentHelp}</Text>
							</Box>
						)}
					</Box>
				)
			})}
			{showBottomIndicator && <Text color={theme.muted}>… {items.length - visibleStart - visibleCount} more below</Text>}
		</Box>
	)
}
