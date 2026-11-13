import { DiracAskResponse } from "@shared/WebviewMessage"
import { CheckIcon, ChevronDownIcon, ChevronLeftIcon, ChevronRightIcon } from "lucide-react"
import { useLayoutEffect, useMemo, useRef, useState } from "react"
import { useShallow } from "zustand/react/shallow"
import { useChatStore } from "@/features/chat/store/chatStore"
import type { MessageHandlers } from "../types/chatTypes"
import { approvalRequestText, selectApprovalCardId, selectPendingApprovalCards } from "../utils/approvalQueue"
import "./ApprovalTray.css"

interface ApprovalTrayProps {
	messageHandlers: Pick<MessageHandlers, "executeButtonAction">
}

/** A fixed sibling of the transcript and composer, never part of virtualized history. */
export function ApprovalTray({ messageHandlers }: ApprovalTrayProps) {
	const cards = useChatStore(useShallow(selectPendingApprovalCards))
	const [selectedId, setSelectedId] = useState<string>()
	const previousIds = useRef<string[]>([])
	const ids = useMemo(() => cards.map((card) => card.id), [cards])
	const currentId = selectApprovalCardId(ids, selectedId, previousIds.current)
	const index = cards.findIndex((card) => card.id === currentId)
	const card = cards[index]
	const [processingId, setProcessingId] = useState<string>()
	const inFlight = useRef(false)
	const [error, setError] = useState<{ cardId: string; message: string }>()

	useLayoutEffect(() => {
		setSelectedId(currentId)
		previousIds.current = ids
	}, [currentId, ids])

	if (!card) return null

	const choices = card.commandApprovalChoices
	const approve = choices?.find((choice) => choice.id === "approve")
	const reject = choices?.find((choice) => choice.id === "reject")
	const grants = choices?.filter((choice) => choice.id !== "approve" && choice.id !== "reject").slice(0, 2) ?? []
	const disabled = processingId !== undefined

	const decide = async (action: DiracAskResponse.APPROVE | DiracAskResponse.REJECT, choiceId?: string) => {
		if (inFlight.current) return
		// Read the live queue again: a removed waiter must never be addressed by a stale event.
		if (!selectPendingApprovalCards(useChatStore.getState()).some((pending) => pending.id === card.id)) return
		inFlight.current = true
		setProcessingId(card.id)
		setError(undefined)
		try {
			await messageHandlers.executeButtonAction(action, undefined, undefined, undefined, undefined, card.id, choiceId)
		} catch (failure) {
			setError({ cardId: card.id, message: failure instanceof Error ? failure.message : "Approval failed" })
		} finally {
			inFlight.current = false
			setProcessingId(undefined)
		}
	}

	return (
		<section aria-label="Pending approval" className="approval-tray" data-card-id={card.id}>
			<div className="approval-tray-heading">
				<pre className="approval-tray-request">{approvalRequestText(card)}</pre>
				{cards.length > 1 && (
					<nav aria-label="Approval queue" className="approval-tray-navigation">
						<button aria-label="Previous approval" disabled={disabled} onClick={() => setSelectedId(ids[(index - 1 + ids.length) % ids.length])} type="button">
							<ChevronLeftIcon aria-hidden="true" size={15} />
						</button>
						<span aria-live="polite">{index + 1} of {cards.length}</span>
						<button aria-label="Next approval" disabled={disabled} onClick={() => setSelectedId(ids[(index + 1) % ids.length])} type="button">
							<ChevronRightIcon aria-hidden="true" size={15} />
						</button>
					</nav>
				)}
			</div>
			<details className="approval-tray-details" key={card.id}>
				<summary aria-label="Request details" title="Request details"><ChevronDownIcon aria-hidden="true" size={15} /></summary>
				<div className="approval-tray-context">
					{card.body && <pre>{card.body}</pre>}
					{card.rawInput && <pre>{JSON.stringify(card.rawInput, null, 2)}</pre>}
				</div>
			</details>
			<div className="approval-tray-actions">
				<div className="approval-tray-once">
					<button className="approval-tray-option approval-tray-allow" disabled={disabled || (!!choices && !approve)} onClick={() => void decide(DiracAskResponse.APPROVE, approve?.id)} type="button">Approve once</button>
					<button className="approval-tray-option approval-tray-reject" disabled={disabled || (!!choices && !reject)} onClick={() => void decide(DiracAskResponse.REJECT, reject?.id)} type="button">Reject</button>
				</div>
				{grants.map((choice) => (
					<button className="approval-tray-option approval-tray-allow approval-tray-grant" disabled={disabled} key={choice.id} onClick={() => void decide(DiracAskResponse.APPROVE, choice.id)} title={choice.label} type="button">
						<CheckIcon aria-hidden="true" size={15} />
						<span>{choice.category && choice.access ? <>All <code>{choice.category}:{choice.access}</code></> : choice.label}</span>
						<small>This task</small>
					</button>
				))}
			</div>
			{error?.cardId === card.id && <div className="approval-tray-error" role="alert">{error.message}</div>}
		</section>
	)
}
