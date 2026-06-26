import { ModularChatTextArea } from "../ModularChatTextArea"
import QuotedMessagePreview from "@/shared/ui/QuotedMessagePreview"
import { useSettingsStore } from "@/features/settings/store/settingsStore"
import { ChatSection, ChatViewContext } from "../types"
import React from "react"

const InputSectionContent: React.FC<{ context: ChatViewContext }> = ({ context }) => {
	const { navigateToSettingsModelPicker } = useSettingsStore()
	const {
		chatState,
		messageHandlers,
		scrollBehavior,
		placeholderText,
		shouldDisableFilesAndImages,
		selectFilesAndImages,
		selectedModelInfo,
	} = context

	const { activeQuote, setActiveQuote, isTextAreaFocused, inputValue, selectedImages, selectedFiles, textAreaRef, taskStatus } =
		chatState

	const { isAtBottomRef, scrollToBottomAuto } = scrollBehavior

	return (
		<>
			{activeQuote && (
				<div className="mb-[-12px] mt-[10px]">
					<QuotedMessagePreview
						isFocused={isTextAreaFocused}
						onDismiss={() => setActiveQuote(null)}
						text={activeQuote}
					/>
				</div>
			)}

			<ModularChatTextArea
				className="mt-2"
				mode={selectedModelInfo.mode}
				modelDisplayName={`${selectedModelInfo.selectedProvider}:${selectedModelInfo.name || selectedModelInfo.selectedModelId}`}
				inputValue={inputValue}
				setInputValue={chatState.setInputValue}
				selectedFiles={selectedFiles}
				setSelectedFiles={chatState.setSelectedFiles}
				selectedImages={selectedImages}
				setSelectedImages={chatState.setSelectedImages}
				onModelButtonClick={() => {
					navigateToSettingsModelPicker({ targetSection: "api-config" })
				}}
				onSelectFilesAndImages={selectFilesAndImages}
				onSend={() => messageHandlers.handleSendMessage(inputValue, selectedImages, selectedFiles)}
				placeholder={placeholderText}
				shouldDisableFilesAndImages={shouldDisableFilesAndImages}
				sendingDisabled={chatState.sendingDisabled}
				taskStatus={taskStatus}
				onHeightChange={() => {
					if (isAtBottomRef.current) {
						scrollToBottomAuto()
					}
				}}
			/>
		</>
	)
}

export const InputSection: ChatSection = {
	id: "input",
	shouldRender: () => true,
	render: (context: ChatViewContext) => <InputSectionContent context={context} />,
}
