import TaskHeader from "../components/TaskHeader/TaskHeader"
import { ChatSection, ChatViewContext } from "../types"

export const TaskSection: ChatSection = {
	id: "task-header",
	shouldRender: (context) => !!context.task,
	render: (context: ChatViewContext) => (
		<TaskHeader
			task={context.task!}
			totalCost={context.apiMetrics.totalCost}
			lastApiReqInfo={context.lastApiReqInfo}
			onClose={context.messageHandlers.handleTaskCloseButtonClick}
			onSendMessage={context.messageHandlers.handleSendMessage}
		/>
	),
}
