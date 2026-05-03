import { DiracMessage, DiracSayTool } from "@shared/ExtensionMessage"
import { useMemo, useState, useCallback } from "react"
import { serializeToolToDisplayUnits } from "../ChatView/utils/toolSerialization"
import { ToolRow } from "./ToolRow"
import { FileServiceClient } from "@/shared/api/grpc-client"
import { StringRequest } from "@shared/proto/dirac/common"
import { getComponentForTool } from "./ToolRegistry"
import { ApprovalBox } from "./ApprovalBox"
import { useMessageHandlers } from "../ChatView/hooks/useMessageHandlers"
import { useChatStore } from "../../store/chatStore"

const handlePathClick = (path: string) => {
	FileServiceClient.openFileRelativePath(StringRequest.create({ value: path })).catch((err: any) =>
		console.error("Failed to open file:", err)
	)
}


interface ToolOutputProps {
	tool: DiracSayTool
	message: DiracMessage
	isExpanded: boolean
	onToggleExpand: (ts: number) => void
	onHeightChange?: (isTaller: boolean) => void
	backgroundEditEnabled?: boolean
}

export const ToolOutput = ({ tool, message, isExpanded, onToggleExpand, backgroundEditEnabled }: ToolOutputProps) => {
	const [isProcessing, setIsProcessing] = useState(false)
	const [expandedItems, setExpandedItems] = useState<Record<string, boolean>>({})
	const messages = useChatStore((state) => state.diracMessages)
	const chatState = {
		diracAsk: message.ask,
		lastMessage: message,
		setInputValue: () => {},
		setActiveQuote: () => {},
		setSelectedImages: () => {},
		setSelectedFiles: () => {},
		setSendingDisabled: () => {},
		setEnableButtons: () => {},
	} as any
	const { executeButtonAction } = useMessageHandlers(messages, chatState)

	const handleAction = useCallback(
		async (action: any) => {
			if (isProcessing) return
			setIsProcessing(true)
			try {
				await executeButtonAction(action)
			} finally {
				setIsProcessing(false)
			}
		},
		[executeButtonAction, isProcessing]
	)

	const displayUnits = useMemo(() => {
		const units = serializeToolToDisplayUnits(tool, message)
		return units.map((unit) => ({
			...unit,
			hasComponent: !!getComponentForTool(unit.type),
		}))
	}, [tool, message])

	const handleToggleExpand = useCallback((id: string) => {
		setExpandedItems((prev) => ({ ...prev, [id]: !prev[id] }))
	}, [])

	const Component = getComponentForTool(tool.tool)

	const isPending = displayUnits.some((u) => u.status === "pending")

	const content = (
		<div className="flex flex-col gap-1 min-w-0">
			{displayUnits.map((unit) => (
				<div key={unit.id} className="flex flex-col gap-1">
					<ToolRow
						unit={unit}
						isExpanded={expandedItems[unit.id] ?? isExpanded}
						onToggleExpand={handleToggleExpand}
						onPathClick={handlePathClick}
					/>
					{Component && (expandedItems[unit.id] ?? isExpanded) && (
						<div className="ml-4 mt-1 border-l-2 border-editor-group-border pl-2">
							<Component
								unit={unit}
								tool={tool}
								message={message}
								isExpanded={true}
								onToggleExpand={() => handleToggleExpand(unit.id)}
								backgroundEditEnabled={backgroundEditEnabled}
							/>
						</div>
					)}
				</div>
			))}
		</div>
	)

	if (isPending) {
		const description =
			displayUnits.length > 1
				? `Approve ${displayUnits.length} actions`
				: `Approve ${displayUnits[0].label}`

		const hint = tool.hint ? `

\${tool.hint}` : ""
		const fullDescription = description + hint

		return (
			<ApprovalBox
				isProcessing={isProcessing}
				description={fullDescription}
				onApprove={() => handleAction("approve")}
				onReject={() => handleAction("reject")}
				onEdit={undefined}>
				{content}
			</ApprovalBox>
		)
	}

	return content
}

