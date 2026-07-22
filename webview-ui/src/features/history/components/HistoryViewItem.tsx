import type { HistoryItem } from "@shared/HistoryItem"
import { StringRequest } from "@shared/proto/dirac/common"
import { VSCodeCheckbox } from "@vscode/webview-ui-toolkit/react"
import {
	ArrowDownIcon,
	ArrowLeftIcon,
	ArrowRightIcon,
	ArrowUpIcon,
	ChevronsDownUpIcon,
	ChevronsUpDownIcon,
	DownloadIcon,
	StarIcon,
	TrashIcon,
} from "lucide-react"
import { memo, useCallback, useMemo, useState } from "react"
import { cn } from "@/lib/utils"
import { TaskServiceClient } from "@/shared/api/grpc-client"
import { formatLargeNumber, formatSize } from "@/shared/lib/format"
import { Button } from "@/shared/ui/button"

type HistoryViewItemProps = {
	item: HistoryItem
	isSelected: boolean
	isDeleting: boolean
	actionsDisabled: boolean
	pendingFavoriteToggles: Record<string, boolean>
	handleDeleteHistoryItem: (id: string) => void
	toggleFavorite: (id: string, isCurrentlyFavorited: boolean) => void
	handleHistorySelect: (itemId: string, checked: boolean) => void
}

const HistoryViewItem = ({
	item,
	pendingFavoriteToggles,
	handleDeleteHistoryItem,
	toggleFavorite,
	handleHistorySelect,
	isSelected,
	isDeleting,
	actionsDisabled,
}: HistoryViewItemProps) => {
	const [expanded, setExpanded] = useState(false)
	const detailsId = `history-details-${item.id}`

	const isFavoritedItem = useMemo(
		() => pendingFavoriteToggles[item.id] ?? item.isFavorited,
		[item.id, item.isFavorited, pendingFavoriteToggles],
	)

	const showTask = useCallback(() => {
		TaskServiceClient.showTaskWithId(StringRequest.create({ value: item.id })).catch((error) =>
			console.error("Error showing task:", error),
		)
	}, [item.id])

	const formatDate = useCallback((timestamp: number) => {
		const date = new Date(timestamp)
		const today = new Date()
		const options: Intl.DateTimeFormatOptions =
			today.toDateString() === date.toDateString()
				? { hour: "numeric", minute: "2-digit", hour12: true }
				: { month: "long", day: "numeric", hour: "numeric", minute: "2-digit", hour12: true }
		return date.toLocaleString("en-US", options).replace(", ", " ").replace(" at", ",")
	}, [])

	return (
		<article
			aria-busy={isDeleting}
			className={cn(
				"history-item group mb-1 flex border-b border-accent/10 hover:bg-list-hover",
				isDeleting && "opacity-50",
			)}>
			<VSCodeCheckbox
				aria-label={`Select ${item.task}`}
				checked={isSelected}
				className="mt-3 self-start py-auto pl-3 pr-1"
				disabled={actionsDisabled}
				onChange={(event) => handleHistorySelect(item.id, (event.target as HTMLInputElement).checked)}
			/>

			<div className="relative flex min-w-0 flex-grow flex-col gap-2 py-2 pl-2 pr-3">
				<div className="flex items-center gap-2">
					<button
						className="min-w-0 flex-1 cursor-pointer overflow-hidden border-0 bg-transparent p-0 text-left focus-visible:outline-1 focus-visible:outline-ring"
						onClick={showTask}
						title="Open task"
						type="button">
						<span className="ph-no-capture line-clamp-1 break-words whitespace-pre-wrap">{item.task}</span>
					</button>
					<div className="flex flex-shrink-0 gap-2">
						<Button
							aria-label="Delete task"
							className="p-0 opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100"
							disabled={isFavoritedItem || actionsDisabled}
							onClick={() => handleDeleteHistoryItem(item.id)}
							title={isFavoritedItem ? "Remove this task from favorites before deleting it" : "Delete task"}
							variant="ghost">
							<TrashIcon className="stroke-1" />
						</Button>
						<Button
							aria-label={isFavoritedItem ? "Remove from favorites" : "Add to favorites"}
							className="p-0"
							disabled={pendingFavoriteToggles[item.id] !== undefined || actionsDisabled}
							onClick={() => toggleFavorite(item.id, Boolean(isFavoritedItem))}
							variant="icon">
							<StarIcon
								className={cn("opacity-70", {
									"fill-button-background text-button-background opacity-100": isFavoritedItem,
								})}
							/>
						</Button>
					</div>
				</div>

				<Button
					aria-controls={detailsId}
					aria-expanded={expanded}
					aria-label={expanded ? "Hide task details" : "Show task details"}
					className="w-full p-0"
					onClick={() => setExpanded((current) => !current)}
					variant="icon">
					<span className="flex w-full items-center justify-between">
						<span className="text-xs uppercase text-description">{formatDate(item.ts)}</span>
						<span className="flex items-center text-xs">
							<span className="text-description">${item.totalCost?.toFixed(4) ?? "0.0000"}</span>
							{expanded ? (
								<ChevronsDownUpIcon className="text-description" />
							) : (
								<ChevronsUpDownIcon className="text-description opacity-60 group-hover:opacity-100" />
							)}
						</span>
					</span>
				</Button>

				{expanded && (
					<div className="m-0 w-full rounded-xs bg-accent/10 p-2 text-xs" id={detailsId}>
						<div className="flex w-full flex-col gap-1 text-xs">
							<div className="flex w-full items-center justify-between gap-1">
								<span className="font-medium text-description">Tokens:</span>
								<span className="flex items-center gap-1 text-xs text-description">
									<span className="flex items-center gap-1">
										<ArrowUpIcon className="!size-1" />
										{formatLargeNumber(item.tokensIn || 0)}
									</span>
									<span className="flex items-center gap-1">
										<ArrowDownIcon className="!size-1" />
										{formatLargeNumber(item.tokensOut || 0)}
									</span>
									{Boolean(item.cacheWrites) && (
										<span className="flex items-center gap-1">
											<ArrowRightIcon className="!size-1" />
											{formatLargeNumber(item.cacheWrites || 0)}
										</span>
									)}
									{Boolean(item.cacheReads) && (
										<span className="flex items-center gap-1">
											<ArrowLeftIcon className="!size-1" />
											{formatLargeNumber(item.cacheReads || 0)}
										</span>
									)}
								</span>
							</div>

							{item.modelId && (
								<div className="flex w-full items-start justify-between gap-2">
									<span className="font-medium text-description">Model:</span>
									<span className="break-all text-right text-description">{item.modelId}</span>
								</div>
							)}

							<div className="flex w-full items-center justify-between gap-1">
								<span className="font-medium text-description">Size:</span>
								<span className="flex items-center gap-2 text-description">
									{formatSize(item.size)}
									<Button
										aria-label="Export task"
										className="m-0 p-0"
										onClick={() =>
											TaskServiceClient.exportTaskWithId(StringRequest.create({ value: item.id })).catch(
												(error) => console.error("Failed to export task:", error),
											)
										}
										variant="ghost">
										<DownloadIcon />
									</Button>
								</span>
							</div>
						</div>
					</div>
				)}
			</div>
		</article>
	)
}

export default memo(HistoryViewItem)
