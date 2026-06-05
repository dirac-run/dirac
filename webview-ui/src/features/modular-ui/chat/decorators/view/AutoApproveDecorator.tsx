import AutoApproveBar from "../../components/AutoApprove/AutoApproveBar"
import { ChatViewDecorator } from "../../types"

export const AutoApproveDecorator: ChatViewDecorator = {
	id: "auto-approve",
	render: () => <AutoApproveBar />,
}
