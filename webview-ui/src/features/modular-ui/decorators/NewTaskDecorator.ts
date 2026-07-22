import { CardDecorator } from "./types"
import { isNewTaskCard } from "../utils/newTaskCard"

export const NewTaskDecorator: CardDecorator = {
	id: "new-task",
	shouldApply: isNewTaskCard,
	suppressDefaultActions: true,
}
