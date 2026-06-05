import { TaskStatus } from "./ExtensionMessage"

export type TaskStatusTone = "muted" | "active" | "warning" | "success"

export interface TaskStatusProjection {
    status: TaskStatus
    label: string
    description: string
    isBusy: boolean
    tone: TaskStatusTone
}

const BUSY_TASK_STATUSES = new Set<TaskStatus>([
    TaskStatus.PREPARING,
    TaskStatus.WAITING_FOR_API,
    TaskStatus.THINKING,
    TaskStatus.STREAMING_TEXT,
    TaskStatus.BUILDING_TOOL_CALL,
    TaskStatus.EXECUTING_TOOL,
    TaskStatus.BUILDING_REQUEST,
    TaskStatus.CANCELLING,
])

const TASK_STATUS_LABELS: Record<TaskStatus, Pick<TaskStatusProjection, "label" | "description" | "tone">> = {
    [TaskStatus.IDLE]: {
        label: "Ready",
        description: "No active task.",
        tone: "muted",
    },
    [TaskStatus.COMPLETED]: {
        label: "Done",
        description: "The task finished successfully.",
        tone: "success",
    },
    [TaskStatus.PREPARING]: {
        label: "Preparing",
        description: "Gathering conversation history, rules, and context before building the request.",
        tone: "active",
    },
    [TaskStatus.WAITING_FOR_API]: {
        label: "Sending",
        description: "Request sent to the model, waiting for the first response token.",
        tone: "active",
    },
    [TaskStatus.THINKING]: {
        label: "Reasoning",
        description: "The model is working through its reasoning before responding.",
        tone: "active",
    },
    [TaskStatus.STREAMING_TEXT]: {
        label: "Writing",
        description: "The model is streaming its text response.",
        tone: "active",
    },
    [TaskStatus.BUILDING_TOOL_CALL]: {
        label: "Streaming toolcall",
        description: "The model is streaming tool call arguments to invoke a tool.",
        tone: "active",
    },
    [TaskStatus.EXECUTING_TOOL]: {
        label: "Running tool",
        description: "A tool is running on your machine.",
        tone: "active",
    },
    [TaskStatus.BUILDING_REQUEST]: {
        label: "Composing",
        description: "Assembling the full conversation and context for the next API call.",
        tone: "active",
    },
    [TaskStatus.CANCELLED]: {
        label: "Cancelled",
        description: "The task was cancelled. Send a message or click Resume to continue.",
        tone: "warning",
    },
    [TaskStatus.AWAITING_USER_INPUT]: {
        label: "Needs input",
        description: "The task is waiting for you to respond or approve a tool action.",
        tone: "warning",
    },
    [TaskStatus.CANCELLING]: {
        label: "Stopping",
        description: "Abort requested. Cleaning up active processes.",
        tone: "warning",
    },
}

export function projectTaskStatus(status: TaskStatus | undefined): TaskStatusProjection {
    const normalizedStatus = status ?? TaskStatus.IDLE
    const projection = TASK_STATUS_LABELS[normalizedStatus]

    return {
        status: normalizedStatus,
        label: projection.label,
        description: projection.description,
        isBusy: BUSY_TASK_STATUSES.has(normalizedStatus),
        tone: projection.tone,
    }
}

export function isBusyTaskStatus(status: TaskStatus | undefined): boolean {
    return projectTaskStatus(status).isBusy
}
