import {
	TASKLET_RECEIPT_OPERATIONS,
	TASKLET_RECEIPT_OUTCOMES,
	taskletReceiptNote,
	taskletReceiptRowTitle,
	type TaskletReceipt,
	type TaskletReceiptTone,
} from "@shared/taskletReceipt"
import { TASKLET_STATE_LABELS } from "@shared/taskletObservation"
import { Text } from "ink"
import React from "react"
import { theme } from "../../constants/theme"

export function taskletReceiptColor(tone: TaskletReceiptTone): string {
	return tone === "neutral" ? theme.muted : theme[tone]
}

/** Receipts contain evidence only, including when viewed inside a passive transcript. */
export function TaskletReceiptBody({ receipt }: { receipt: TaskletReceipt }) {
	const note = taskletReceiptNote(receipt)
	return (
		<Text color={theme.toolBody}>
			{receipt.rows.map((row, index) => (
				<React.Fragment key={index}>
					{index > 0 ? "\n\n" : ""}
					<Text color={theme.toolHeader}>
						{TASKLET_RECEIPT_OPERATIONS[row.operation].label} · {taskletReceiptRowTitle(row)}
					</Text>
					{" — "}
					<Text color={taskletReceiptColor(TASKLET_RECEIPT_OUTCOMES[row.outcome].tone)}>
						{TASKLET_RECEIPT_OUTCOMES[row.outcome].label}
					</Text>
					{row.observedState && (
						<Text color={theme.muted}>{`\nObserved: ${TASKLET_STATE_LABELS[row.observedState]}`}</Text>
					)}
					{row.message && `\n${row.message}`}
					{row.choice && `\nChoice: ${row.choice}`}
					{row.request && `\nRequest: ${row.request}`}
					{row.decision && (
						<Text
							color={
								theme.muted
							}>{`\nDecision: ${row.decision} · this request only, within parent authority`}</Text>
					)}
					{row.error && <Text color={theme.error}>{`\nError: ${row.error}`}</Text>}
				</React.Fragment>
			))}
			{note && <Text color={theme.muted}>{`${receipt.rows.length ? "\n\n" : ""}${note}`}</Text>}
			{receipt.error && (
				<Text color={theme.error}>{`${receipt.rows.length || note ? "\n\n" : ""}Error: ${receipt.error}`}</Text>
			)}
		</Text>
	)
}
