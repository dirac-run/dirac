import { StringRequest } from "@shared/proto/dirac/common"
import { memo, useMemo } from "react"
import DiracLogoVariable from "@/assets/DiracLogoVariable"
import { useTaskStore } from "@/entities/task/store/taskStore"
import { TaskServiceClient } from "@/shared/api/grpc-client"
import { getRandomQuote } from "@shared/quotes"

type HistoryPreviewProps = {
	showHistoryView: () => void
}

const HistoryPreview = ({ showHistoryView }: HistoryPreviewProps) => {
	const taskHistory = useTaskStore((state) => state.taskHistory)
	const quote = useMemo(() => getRandomQuote(), [])
	const handleHistorySelect = (id: string) => {
		TaskServiceClient.showTaskWithId(StringRequest.create({ value: id })).catch((error) =>
			console.error("Error showing task:", error),
		)
	}

	const formatDate = (timestamp: number) => {
		const date = new Date(timestamp)
		return date?.toLocaleString("en-US", {
			month: "short",
			day: "numeric",
		})
	}

	return (
		<div style={{ flexShrink: 0 }}>
			<style>
				{`
					.history-preview-item {
						background-color: color-mix(in srgb, var(--vscode-toolbar-hoverBackground) 65%, transparent);
						border-radius: 4px;
						position: relative;
						overflow: hidden;
						cursor: pointer;
						margin-bottom: 8px;
						padding: 10px 12px;
						display: flex;
						align-items: flex-start;
						gap: 12px;
					}
					.history-preview-item:hover {
						background-color: color-mix(in srgb, var(--vscode-toolbar-hoverBackground) 100%, transparent);
						pointer-events: auto;
					}
					.history-task-content {
						flex: 1;
						display: flex;
						align-items: flex-start;
						gap: 8px;
						min-width: 0;
					}
					.history-task-description {
						flex: 1;
						overflow: hidden;
						display: -webkit-box;
						-webkit-line-clamp: 2;
						-webkit-box-orient: vertical;
						color: var(--vscode-foreground);
						font-size: var(--vscode-font-size);
						line-height: 1.4;
					}
					.history-meta-stack {
						display: flex;
						flex-direction: column;
						align-items: center;
						gap: 4px;
						flex-shrink: 0;
					}
					.history-date {
						color: var(--vscode-descriptionForeground);
						font-size: 0.85em;
						white-space: nowrap;
					}
					.history-cost-chip {
						background-color: var(--vscode-badge-background);
						color: var(--vscode-badge-foreground);
						padding: 2px 8px;
						border-radius: 12px;
						font-size: 0.85em;
						font-weight: 500;
						white-space: nowrap;
					}
					.history-view-all-btn {
						background: none;
						border: none;
						padding: 4px 0 4px 8px;
						cursor: pointer;
						font-size: 0.85em;
						font-weight: 500;
						color: var(--vscode-descriptionForeground);
						white-space: nowrap;
						display: flex;
						align-items: center;
						gap: 2px;
					.history-view-all-btn .codicon {
						font-size: 1.2em;
					}
					.history-view-all-btn:hover {
						color: var(--vscode-foreground);
					}
				`}
			</style>

			<div
				className="history-header"
				style={{
					color: "var(--vscode-descriptionForeground)",
					margin: "10px 16px 10px 16px",
					display: "flex",
					alignItems: "center",
					justifyContent: "space-between",
				}}>
				<div style={{ display: "flex", alignItems: "center" }}>
					<span
						className="codicon codicon-comment-discussion"
						style={{
							marginRight: "4px",
							transform: "scale(0.9)",
						}}
					/>
					<span
						style={{
							fontWeight: 500,
							fontSize: "0.85em",
							textTransform: "uppercase",
						}}>
						Recent
					</span>
				</div>
				{taskHistory.filter((item: any) => item.ts && item.task).length > 0 && (
					<button
						aria-label="View all history"
						className="history-view-all-btn"
						onClick={() => showHistoryView()}
						type="button">
						View All
						<span className="codicon codicon-chevron-right" />
					</button>
				)}
			</div>
			<div className="px-4">
				<div className="flex justify-center py-3 pb-5">
					<div className="flex flex-col items-center gap-2">
						<div className="relative">
							<div className="absolute -inset-6 rounded-[40%_60%_55%_45%/60%_40%_55%_45%] bg-[radial-gradient(ellipse_at_40%_30%,rgba(150,99,241,0.18)_0%,rgba(150,99,241,0.08)_40%,transparent_70%)] blur-sm animate-glow-pulse pointer-events-none" />
							<div
								className="absolute -inset-4 rounded-[55%_45%_40%_60%/45%_55%_60%_40%] bg-[radial-gradient(ellipse_at_60%_70%,rgba(139,92,246,0.12)_0%,rgba(150,99,241,0.05)_50%,transparent_75%)] blur-md animate-glow-pulse pointer-events-none"
								style={{ animationDelay: "2s" }}
							/>
							<DiracLogoVariable />
						</div>
						<div className="text-[0.9em] text-(--vscode-textLink-foreground) italic text-center max-w-[80%] leading-[1.4]">
							"{quote}"
						</div>
					</div>
				</div>
			</div>

			{
				<div className="px-4">
					{taskHistory.filter((item: any) => item.ts && item.task).length > 0 ? (
						taskHistory
							.filter((item: any) => item.ts && item.task)
							.slice(0, 3)
							.map((item: any) => (
								<div className="history-preview-item" key={item.id} onClick={() => handleHistorySelect(item.id)}>
									<div className="history-task-content">
										{item.isFavorited && (
											<span
												aria-label="Favorited"
												className="codicon codicon-star-full"
												style={{
													color: "var(--vscode-button-background)",
													flexShrink: 0,
												}}
											/>
										)}
										<div className="history-task-description ph-no-capture">{item.task}</div>
									</div>
									<div className="history-meta-stack">
										<span className="history-date">{formatDate(item.ts)}</span>
										{item.totalCost != null && (
											<span className="history-cost-chip">${item.totalCost.toFixed(2)}</span>
										)}
									</div>
								</div>
							))
					) : (
						<div
							style={{
								textAlign: "center",
								color: "var(--vscode-descriptionForeground)",
								fontSize: "var(--vscode-font-size)",
								padding: "10px 0",
							}}>
							No recent tasks
						</div>
					)}
				</div>
			}
		</div>
	)
}

export default memo(HistoryPreview)
