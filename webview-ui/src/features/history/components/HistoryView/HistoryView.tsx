import type { HistoryItem } from "@shared/HistoryItem"
import { BooleanRequest, EmptyRequest, StringArrayRequest } from "@shared/proto/dirac/common"
import { GetTaskHistoryRequest, TaskFavoriteRequest } from "@shared/proto/dirac/task"
import { VSCodeTextField } from "@vscode/webview-ui-toolkit/react"
import Fuse, { type FuseResult } from "fuse.js"
import { FunnelIcon } from "lucide-react"
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react"
import { GroupedVirtuoso, Virtuoso } from "react-virtuoso"
import { useAppStore } from "@/app/store/appStore"
import { useTaskStore } from "@/entities/task/store/taskStore"
import { TaskServiceClient } from "@/shared/api/grpc-client"
import { formatSize } from "@/shared/lib/format"
import { Button } from "@/shared/ui/button"
import { Select, SelectContent, SelectItem, SelectTrigger } from "@/shared/ui/select"
import ViewHeader from "@/shared/ui/ViewHeader"
import HistoryViewItem from "../HistoryViewItem"

type HistoryViewProps = {
	onDone: () => void
}

type SortOption = "newest" | "oldest" | "mostExpensive" | "mostTokens" | "mostRelevant"

const isToday = (timestamp: number): boolean => {
	const date = new Date(timestamp)
	const today = new Date()
	return today.toDateString() === date.toDateString()
}

const HISTORY_FILTERS = {
	newest: "Newest",
	oldest: "Oldest",
	mostExpensive: "Most Expensive",
	mostTokens: "Most Tokens",
	mostRelevant: "Most Relevant",
	workspaceOnly: "Workspace Only",
	favoritesOnly: "Favorites Only",
}

const HistoryView = ({ onDone }: HistoryViewProps) => {
	const taskHistory = useTaskStore((state) => state.taskHistory)
	const setTaskHistory = useTaskStore((state) => state.setTaskHistory)
	const totalTasksSize = useTaskStore((state) => state.totalTasksSize)
	const setTotalTasksSize = useTaskStore((state) => state.setTotalTasksSize)
	const onRelinquishControl = useAppStore((state) => state.onRelinquishControl)
	const environment = useAppStore((state) => state.environment)
	const [searchQuery, setSearchQuery] = useState("")
	const [sortOption, setSortOption] = useState<SortOption>("newest")
	const [lastNonRelevantSort, setLastNonRelevantSort] = useState<SortOption>("newest")
	const [selectedItems, setSelectedItems] = useState<string[]>([])
	const [showFavoritesOnly, setShowFavoritesOnly] = useState(false)
	const [showCurrentWorkspaceOnly, setShowCurrentWorkspaceOnly] = useState(false)
	const [pendingFavoriteToggles, setPendingFavoriteToggles] = useState<Record<string, boolean>>({})
	const [deletingTaskIds, setDeletingTaskIds] = useState<Set<string>>(() => new Set())
	const [isDeletingAll, setIsDeletingAll] = useState(false)
	const [tasks, setTasks] = useState<HistoryItem[]>(taskHistory)
	const [isLoading, setIsLoading] = useState(true)
	const [loadError, setLoadError] = useState<string | null>(null)
	const loadRequestIdRef = useRef(0)

	const loadTaskHistory = useCallback(async () => {
		const requestId = ++loadRequestIdRef.current
		setIsLoading(true)
		setLoadError(null)

		try {
			const response = await TaskServiceClient.getTaskHistory(
				GetTaskHistoryRequest.create({
					favoritesOnly: showFavoritesOnly,
					searchQuery: searchQuery || undefined,
					sortBy: sortOption,
					currentWorkspaceOnly: showCurrentWorkspaceOnly,
				}),
			)
			if (requestId === loadRequestIdRef.current) {
				setTasks(response.tasks || [])
			}
		} catch (error) {
			console.error("Error loading task history:", error)
			if (requestId === loadRequestIdRef.current) {
				setLoadError("History could not be loaded. Please try again.")
			}
		} finally {
			if (requestId === loadRequestIdRef.current) {
				setIsLoading(false)
			}
		}
	}, [searchQuery, showCurrentWorkspaceOnly, showFavoritesOnly, sortOption])

	useEffect(() => {
		void loadTaskHistory()
	}, [loadTaskHistory])

	const fetchTotalTasksSize = useCallback(async () => {
		try {
			const response = await TaskServiceClient.getTotalTasksSize(EmptyRequest.create({}))
			setTotalTasksSize(response.value || 0)
		} catch (error) {
			console.error("Error getting total tasks size:", error)
		}
	}, [setTotalTasksSize])

	useEffect(() => {
		void fetchTotalTasksSize()
	}, [fetchTotalTasksSize])

	useEffect(() => {
		return onRelinquishControl(() => {
			setIsDeletingAll(false)
			setDeletingTaskIds(new Set())
		})
	}, [onRelinquishControl])

	useEffect(() => {
		if (searchQuery && sortOption !== "mostRelevant") {
			setLastNonRelevantSort(sortOption)
			setSortOption("mostRelevant")
			return
		}
		if (!searchQuery && sortOption === "mostRelevant") {
			setSortOption(lastNonRelevantSort)
		}
	}, [lastNonRelevantSort, searchQuery, sortOption])

	useEffect(() => {
		const visibleTaskIds = new Set(tasks.map((task) => task.id))
		setSelectedItems((selected) => selected.filter((id) => visibleTaskIds.has(id)))
	}, [tasks])

	const handleHistorySelect = useCallback((itemId: string, checked: boolean) => {
		setSelectedItems((selected) => {
			if (checked) {
				return selected.includes(itemId) ? selected : [...selected, itemId]
			}
			return selected.filter((id) => id !== itemId)
		})
	}, [])

	const toggleFavorite = useCallback(
		async (taskId: string, currentValue: boolean) => {
			const nextValue = !currentValue
			setPendingFavoriteToggles((pending) => ({ ...pending, [taskId]: nextValue }))
			setTasks((currentTasks) =>
				showFavoritesOnly && !nextValue
					? currentTasks.filter((task) => task.id !== taskId)
					: currentTasks.map((task) => (task.id === taskId ? { ...task, isFavorited: nextValue } : task)),
			)
			const currentHistory = useTaskStore.getState().taskHistory
			setTaskHistory(currentHistory.map((task) => (task.id === taskId ? { ...task, isFavorited: nextValue } : task)))

			try {
				await TaskServiceClient.toggleTaskFavorite(TaskFavoriteRequest.create({ taskId, isFavorited: nextValue }))
				if (showFavoritesOnly || showCurrentWorkspaceOnly) await loadTaskHistory()
			} catch (error) {
				console.error(`[FAVORITE_TOGGLE_UI] Error for task ${taskId}:`, error)
				const latestHistory = useTaskStore.getState().taskHistory
				setTaskHistory(latestHistory.map((task) => (task.id === taskId ? { ...task, isFavorited: currentValue } : task)))
				setLoadError("The favorite could not be updated.")
				await loadTaskHistory()
			} finally {
				setPendingFavoriteToggles((pending) => {
					const updated = { ...pending }
					delete updated[taskId]
					return updated
				})
			}
		},
		[loadTaskHistory, setTaskHistory, showCurrentWorkspaceOnly, showFavoritesOnly],
	)

	const isDestructiveActionPending = isDeletingAll || deletingTaskIds.size > 0

	const deleteTasks = useCallback(
		async (ids: string[]) => {
			if (ids.length === 0 || isDestructiveActionPending) return

			setDeletingTaskIds(new Set(ids))
			setLoadError(null)
			try {
				await TaskServiceClient.deleteTasksWithIds(StringArrayRequest.create({ value: ids }))
			} catch (error) {
				console.error("Error deleting task history:", error)
				setLoadError(ids.length === 1 ? "The task could not be deleted." : "The selected tasks could not be deleted.")
			} finally {
				await Promise.all([fetchTotalTasksSize(), loadTaskHistory()])
				setDeletingTaskIds(new Set())
			}
		},
		[fetchTotalTasksSize, isDestructiveActionPending, loadTaskHistory],
	)

	const deleteAllHistory = useCallback(async () => {
		if (isDestructiveActionPending) return
		setIsDeletingAll(true)
		setLoadError(null)
		try {
			await TaskServiceClient.deleteAllTaskHistory(BooleanRequest.create({}))
			await Promise.all([fetchTotalTasksSize(), loadTaskHistory()])
		} catch (error) {
			console.error("Error deleting task history:", error)
			setLoadError("History could not be deleted.")
		} finally {
			setIsDeletingAll(false)
		}
	}, [fetchTotalTasksSize, isDestructiveActionPending, loadTaskHistory])

	const fuse = useMemo(
		() =>
			new Fuse(tasks, {
				keys: ["task"],
				threshold: 0.6,
				shouldSort: true,
				isCaseSensitive: false,
				ignoreLocation: false,
				includeMatches: true,
				minMatchCharLength: 1,
			}),
		[tasks],
	)

	const taskHistorySearchResults = useMemo(() => {
		const results = searchQuery
			? fuse
					.search(searchQuery)
					.filter(({ matches }) => matches && matches.length)
					.map(({ item }) => item)
			: [...tasks]

		if (sortOption === "mostRelevant" && searchQuery) return results

		return [...results].sort((a, b) => {
			switch (sortOption) {
				case "oldest":
					return a.ts - b.ts
				case "mostExpensive":
					return (b.totalCost || 0) - (a.totalCost || 0)
				case "mostTokens":
					return (
						(b.tokensIn || 0) +
						(b.tokensOut || 0) +
						(b.cacheWrites || 0) +
						(b.cacheReads || 0) -
						((a.tokensIn || 0) + (a.tokensOut || 0) + (a.cacheWrites || 0) + (a.cacheReads || 0))
					)
				default:
					return b.ts - a.ts
			}
		})
	}, [fuse, searchQuery, sortOption, tasks])

	const isDateSort = sortOption === "newest" || sortOption === "oldest"
	const { groupedTasks, groupCounts, groupLabels } = useMemo(() => {
		const todayTasks = taskHistorySearchResults.filter((task) => isToday(task.ts))
		const olderTasks = taskHistorySearchResults.filter((task) => !isToday(task.ts))
		const groups =
			sortOption === "oldest"
				? [
						{ tasks: olderTasks, label: "Older" },
						{ tasks: todayTasks, label: "Today" },
					]
				: [
						{ tasks: todayTasks, label: "Today" },
						{ tasks: olderTasks, label: "Older" },
					]
		const nonEmptyGroups = groups.filter((group) => group.tasks.length > 0)
		return {
			groupedTasks: nonEmptyGroups.flatMap((group) => group.tasks),
			groupCounts: nonEmptyGroups.map((group) => group.tasks.length),
			groupLabels: nonEmptyGroups.map((group) => group.label),
		}
	}, [sortOption, taskHistorySearchResults])

	const selectedItemsSize = useMemo(() => {
		const selectedIds = new Set(selectedItems)
		return tasks.filter((item) => selectedIds.has(item.id)).reduce((total, item) => total + (item.size || 0), 0)
	}, [selectedItems, tasks])

	const selectedItemIds = useMemo(() => new Set(selectedItems), [selectedItems])
	const allVisibleSelected =
		taskHistorySearchResults.length > 0 && taskHistorySearchResults.every((item) => selectedItemIds.has(item.id))
	const hasAnyHistory = taskHistory.length > 0 || tasks.length > 0 || (totalTasksSize ?? 0) > 0

	const renderHistoryItem = useCallback(
		(item: HistoryItem) => (
			<HistoryViewItem
				actionsDisabled={isDestructiveActionPending}
				handleDeleteHistoryItem={(id) => void deleteTasks([id])}
				handleHistorySelect={handleHistorySelect}
				isDeleting={isDeletingAll || deletingTaskIds.has(item.id)}
				isSelected={selectedItemIds.has(item.id)}
				item={item}
				pendingFavoriteToggles={pendingFavoriteToggles}
				toggleFavorite={toggleFavorite}
			/>
		),
		[
			deleteTasks,
			deletingTaskIds,
			handleHistorySelect,
			isDeletingAll,
			isDestructiveActionPending,
			pendingFavoriteToggles,
			selectedItemIds,
			toggleFavorite,
		],
	)

	const historyList = (() => {
		if (isLoading && tasks.length === 0) {
			return <div className="px-4 py-8 text-center text-sm text-description">Loading history…</div>
		}
		if (loadError && tasks.length === 0) {
			return (
				<div className="flex flex-col items-center gap-3 px-4 py-8 text-center text-sm text-error" role="alert">
					<span>{loadError}</span>
					<Button onClick={() => void loadTaskHistory()} size="sm" variant="secondary">
						Retry
					</Button>
				</div>
			)
		}
		if (taskHistorySearchResults.length === 0) {
			return (
				<div className="px-4 py-8 text-center text-sm text-description">
					{searchQuery || showFavoritesOnly || showCurrentWorkspaceOnly
						? "No history matches the current search and filters."
						: "No task history yet."}
				</div>
			)
		}
		if (!isDateSort) {
			return (
				<Virtuoso
					computeItemKey={(_, item) => item.id}
					data={taskHistorySearchResults}
					itemContent={(_, item) => renderHistoryItem(item)}
				/>
			)
		}
		return (
			<GroupedVirtuoso
				computeItemKey={(_, item) => item.id}
				data={groupedTasks}
				groupContent={(index) => (
					<div className="sticky top-0 z-10 border-b border-border-panel bg-sidebar-background px-4 py-2 text-xs font-bold uppercase tracking-wide text-description">
						{groupLabels[index]}
					</div>
				)}
				groupCounts={groupCounts}
				itemContent={(_, __, item) => renderHistoryItem(item)}
			/>
		)
	})()

	return (
		<div className="fixed inset-0 flex w-full flex-col overflow-hidden">
			<ViewHeader environment={environment} onDone={onDone} title="History" />

			<div className="flex flex-col gap-3 px-3">
				<div className="flex items-center justify-between gap-1">
					<VSCodeTextField
						aria-label="Search task history"
						className="w-full"
						onInput={(event) => setSearchQuery((event.target as HTMLInputElement).value)}
						placeholder="Fuzzy search history..."
						value={searchQuery}>
						<div className="codicon codicon-search mt-0.5 !text-sm opacity-80" slot="start" />
						{searchQuery && (
							<button
								aria-label="Clear search"
								className="input-icon-button codicon codicon-close flex h-full items-center justify-center border-0 bg-transparent"
								onClick={() => setSearchQuery("")}
								slot="end"
								type="button"
							/>
						)}
					</VSCodeTextField>
					<Select
						onValueChange={(value) => {
							if (["newest", "oldest", "mostExpensive", "mostTokens", "mostRelevant"].includes(value)) {
								if (value === "mostRelevant" && !searchQuery) return
								setSortOption(value as SortOption)
								if (value !== "mostRelevant") setLastNonRelevantSort(value as SortOption)
								return
							}
							if (value === "workspaceOnly") setShowCurrentWorkspaceOnly((current) => !current)
							if (value === "favoritesOnly") setShowFavoritesOnly((current) => !current)
						}}
						value={sortOption}>
						<SelectTrigger aria-label="Sort and filter history" className="cursor-pointer border-0" showIcon={false}>
							<FunnelIcon className="!size-2 text-foreground" />
						</SelectTrigger>
						<SelectContent position="popper">
							{Object.entries(HISTORY_FILTERS).map(([key, value]) => {
								const isSortOption = ["newest", "oldest", "mostExpensive", "mostTokens", "mostRelevant"].includes(
									key,
								)
								const isFilterOption = key === "workspaceOnly" || key === "favoritesOnly"
								const isSelected = isSortOption
									? sortOption === key
									: key === "workspaceOnly"
										? showCurrentWorkspaceOnly
										: showFavoritesOnly
								return (
									<SelectItem
										className={isSelected ? "bg-button-background/30" : ""}
										disabled={key === "mostRelevant" && !searchQuery}
										key={key}
										value={key}>
										<span className="flex items-center gap-2">
											{isFilterOption && (
												<span
													className={`codicon ${key === "workspaceOnly" ? "codicon-folder" : "codicon-star-full"} ${
														isSelected ? "text-button-background" : ""
													}`}
												/>
											)}
											{value}
										</span>
									</SelectItem>
								)
							})}
						</SelectContent>
					</Select>
				</div>
			</div>

			{loadError && tasks.length > 0 && (
				<div
					className="mx-3 mt-2 rounded-xs border border-error/40 bg-error/10 px-3 py-2 text-xs text-error"
					role="alert">
					{loadError}
				</div>
			)}

			<div className="m-0 min-h-0 w-full flex-grow py-2">{historyList}</div>

			<div className="border-t border-t-border-panel p-2.5">
				<div className="mb-2.5 flex gap-2.5">
					<Button
						className="flex-1"
						disabled={isDestructiveActionPending || taskHistorySearchResults.length === 0 || allVisibleSelected}
						onClick={() => setSelectedItems(taskHistorySearchResults.map((item) => item.id))}
						variant="secondary">
						Select All
					</Button>
					<Button
						className="flex-1"
						disabled={isDestructiveActionPending || selectedItems.length === 0}
						onClick={() => setSelectedItems([])}
						variant="secondary">
						Select None
					</Button>
				</div>
				{selectedItems.length > 0 ? (
					<Button
						aria-label="Delete selected items"
						className="w-full"
						disabled={isDestructiveActionPending}
						onClick={() => void deleteTasks(selectedItems)}
						variant="danger">
						Delete {selectedItems.length > 1 ? selectedItems.length : ""} Selected
						{selectedItemsSize > 0 ? ` (${formatSize(selectedItemsSize)})` : ""}
					</Button>
				) : (
					<Button
						aria-label="Delete all history"
						className="w-full"
						disabled={isDestructiveActionPending || !hasAnyHistory}
						onClick={() => void deleteAllHistory()}
						variant="danger">
						{isDeletingAll ? "Deleting History…" : "Delete All History"}
						{!isDeletingAll && totalTasksSize !== null ? ` (${formatSize(totalTasksSize)})` : ""}
					</Button>
				)}
			</div>
		</div>
	)
}

// https://gist.github.com/evenfrost/1ba123656ded32fb7a0cd4651efd4db0
const escapeHtml = (value: string) =>
	value.replace(/[&<>"']/g, (character) => {
		const entities: Record<string, string> = {
			"&": "&amp;",
			"<": "&lt;",
			">": "&gt;",
			'"': "&quot;",
			"'": "&#39;",
		}
		return entities[character]
	})

export const highlight = (fuseSearchResult: FuseResult<any>[], highlightClassName = "history-item-highlight") => {
	const set = (obj: Record<string, any>, path: string, value: any) => {
		const pathValue = path.split(".")
		let i: number
		for (i = 0; i < pathValue.length - 1; i++) obj = obj[pathValue[i]] as Record<string, any>
		obj[pathValue[i]] = value
	}

	const mergeRegions = (regions: [number, number][]): [number, number][] => {
		if (regions.length === 0) return regions
		regions.sort((a, b) => a[0] - b[0])
		const merged: [number, number][] = [regions[0]]
		for (let i = 1; i < regions.length; i++) {
			const last = merged[merged.length - 1]
			const current = regions[i]
			if (current[0] <= last[1] + 1) last[1] = Math.max(last[1], current[1])
			else merged.push(current)
		}
		return merged
	}

	const generateHighlightedText = (inputText: string, regions: [number, number][] = []) => {
		if (regions.length === 0) return escapeHtml(inputText)
		const mergedRegions = mergeRegions(regions)
		let content = ""
		let nextUnhighlightedRegionStartingIndex = 0
		mergedRegions.forEach(([start, end]) => {
			const lastRegionNextIndex = end + 1
			const prefix = inputText.substring(nextUnhighlightedRegionStartingIndex, start)
			const highlighted = inputText.substring(start, lastRegionNextIndex)
			content += `${escapeHtml(prefix)}<span class="${highlightClassName}">${escapeHtml(highlighted)}</span>`
			nextUnhighlightedRegionStartingIndex = lastRegionNextIndex
		})
		return content + escapeHtml(inputText.substring(nextUnhighlightedRegionStartingIndex))
	}

	return fuseSearchResult
		.filter(({ matches }) => matches && matches.length)
		.map(({ item, matches }) => {
			const highlightedItem = { ...item }
			matches?.forEach((match) => {
				if (match.key && typeof match.value === "string" && match.indices) {
					set(highlightedItem, match.key, generateHighlightedText(match.value, mergeRegions([...match.indices])))
				}
			})
			return highlightedItem
		})
}

export default memo(HistoryView)
