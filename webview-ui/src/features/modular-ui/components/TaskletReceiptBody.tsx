import {
	TASKLET_RECEIPT_OPERATIONS,
	TASKLET_RECEIPT_OUTCOMES,
	taskletReceiptNote,
	type TaskletReceipt,
	type TaskletReceiptOutcome,
	type TaskletReceiptTone,
} from "@shared/taskletReceipt"
import { TASKLET_STATE_LABELS } from "@shared/taskletObservation"
import { cn } from "@/lib/utils"

export const RECEIPT_TONE_CLASSES: Record<TaskletReceiptTone, string> = {
	neutral: "text-muted-foreground border-foreground/15",
	info: "text-link border-link/30",
	success: "text-success border-success/30",
	warning: "text-warning border-warning/30",
	error: "text-error border-error/30",
}

export function TaskletReceiptBadge({ outcome }: { outcome: TaskletReceiptOutcome }) {
	const { label, tone } = TASKLET_RECEIPT_OUTCOMES[outcome]
	return (
		<span className={cn("shrink-0 rounded border px-1.5 py-0 text-xs leading-4", RECEIPT_TONE_CLASSES[tone])}>{label}</span>
	)
}

/** Historical receipt only: deliberately exposes no action callbacks. */
export function TaskletReceiptBody({ receipt }: { receipt: TaskletReceipt }) {
	const note = taskletReceiptNote(receipt)
	return (
		<div className="flex flex-col gap-2.5 text-sm">
			{receipt.rows.map((row, index) => (
				<div className="flex flex-col gap-1 border-l-2 border-foreground/10 pl-2" key={index}>
					<div className="flex flex-wrap items-center gap-1.5">
						<span className="min-w-0 break-words font-medium">{row.title}</span>
						{receipt.operation === "message" && (
							<span className="text-xs text-muted-foreground">
								{TASKLET_RECEIPT_OPERATIONS[row.operation].label}
							</span>
						)}
						<TaskletReceiptBadge outcome={row.outcome} />
					</div>
					{row.observedState && (
						<div className="text-xs text-muted-foreground">Observed: {TASKLET_STATE_LABELS[row.observedState]}</div>
					)}
					{row.message && <div className="whitespace-pre-wrap break-words">{row.message}</div>}
					{row.choice && (
						<div className="whitespace-pre-wrap break-words">
							<span className="text-muted-foreground">Choice: </span>
							{row.choice}
						</div>
					)}
					{row.request && (
						<div className="whitespace-pre-wrap break-words">
							<span className="text-muted-foreground">Request: </span>
							{row.request}
						</div>
					)}
					{row.decision && (
						<div className="text-xs">
							<strong className="capitalize">{row.decision}</strong>
							<span className="text-muted-foreground"> · this request only, within parent authority</span>
						</div>
					)}
					{row.error && <div className="whitespace-pre-wrap break-words text-error">Error: {row.error}</div>}
				</div>
			))}
			{note && <div className="text-xs text-muted-foreground">{note}</div>}
			{receipt.error && <div className="whitespace-pre-wrap break-words text-error">Error: {receipt.error}</div>}
		</div>
	)
}
