import {
    TaskStatus,
    ActionButton,
    DiracMessage,
    DiracMessageType,
    UIActionButton,
    UIActionButtonType,
    UIActionState,
} from "@shared/ExtensionMessage"
import { DiracAskResponse } from "@shared/WebviewMessage"
import { isBusyTaskStatus } from "@shared/taskStatusProjection"
import { TaskState } from "../TaskState"

export function projectUIActionState(state: TaskState, messages: DiracMessage[], maxConsecutiveMistakes: number): UIActionState {
    const taskStatus = state?.status ?? TaskStatus.IDLE
    const uiState: UIActionState = {
        globalButtons: [],
        cardButtons: [],
        sendingDisabled:
            taskStatus !== TaskStatus.IDLE &&
            taskStatus !== TaskStatus.COMPLETED &&
            taskStatus !== TaskStatus.AWAITING_USER_INPUT &&
            taskStatus !== TaskStatus.CANCELLED,

    }


    // Active card interactions must take precedence over busy task states.
    // Tools can create a waiting card before the task status is projected as AWAITING_USER_INPUT.
    if (state?.waitingCardIds && state.waitingCardIds.length > 0) {
        const activeCardId = state.waitingCardIds[0]
        const cardMsg = messages.find((m) => m.id === activeCardId)
        if (cardMsg?.content.type === DiracMessageType.CARD) {
            const card = cardMsg.content.card
            uiState.activeCardId = activeCardId
            uiState.cardButtons = card.actions?.map(mapCardActionToUIButton) || (card.requireApproval ? [
                { label: "Approve", action: UIActionButtonType.APPROVE, primary: true },
                { label: "Reject", action: UIActionButtonType.REJECT, style: "secondary" },
            ] : [])
            return uiState
        }
    }
    // 1. Terminal Success State
    if (state?.didAttemptCompletion) {
        uiState.globalButtons.push({
            label: "Start New Task",
            action: UIActionButtonType.NEW_TASK,
            primary: true,
        })
        return uiState
    }

    // 2. Active Streaming State
    // When awaiting plan feedback, skip the Cancel button and fall through
    // to section 4 so the card renders without action buttons.
    const isBusy = isBusyTaskStatus(state?.status)

    if (isBusy && !state?.isAwaitingPlanResponse) {
        uiState.globalButtons.push({
            label: "Cancel",
            action: UIActionButtonType.CANCEL,
            style: "secondary",
        })
        return uiState
    }

    // 2b. Cancelled State (task was aborted, awaiting resume)
    if (state?.status === TaskStatus.CANCELLED) {
        uiState.globalButtons.push({
            label: "Resume",
            action: UIActionButtonType.APPROVE,
            primary: true,
        })
        return uiState
    }

    // 3. Error Recovery State (Mistake Limit)

    if (state?.consecutiveMistakeCount >= maxConsecutiveMistakes) {
        uiState.globalButtons.push(
            { label: "Proceed Anyways", action: UIActionButtonType.PROCEED, primary: true },
            { label: "Start New Task", action: UIActionButtonType.NEW_TASK, style: "secondary" }
        )
        return uiState
    }

    return uiState
}

function mapCardActionToUIButton(action: ActionButton): UIActionButton {
    return {
        label: action.label,
        action: mapValueToActionButtonType(action.value),
        value: action.value,
        primary: action.primary,
        style: action.style,
    }
}

function mapValueToActionButtonType(value: string): UIActionButtonType {
    switch (value) {
        case DiracAskResponse.APPROVE:
            return UIActionButtonType.APPROVE
        case DiracAskResponse.REJECT:
            return UIActionButtonType.REJECT
        default:
            return UIActionButtonType.UTILITY
    }
}
