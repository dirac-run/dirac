import { ModularChatTextArea } from "../ModularChatTextArea"
import QuotedMessagePreview from "@/shared/ui/QuotedMessagePreview"
import { useSettingsStore } from "@/features/settings/store/settingsStore"
import { ChatSection, ChatViewContext } from "../types"
import React, { useState } from "react"
import { StringRequest } from "@shared/proto/dirac/common"
import { StateServiceClient } from "@/shared/api/grpc-client"
import {
	isOpenaiReasoningEffort,
	OPENAI_REASONING_EFFORT_OPTIONS,
	type OpenaiReasoningEffort,
} from "@shared/ExtensionMessage"
import { supportsReasoningEffortForModelId } from "@/features/settings/components/utils/providerUtils"
import { useApiConfigurationHandlers } from "@/features/settings/components/utils/useApiConfigurationHandlers"

const InputSectionContent: React.FC<{ context: ChatViewContext }> = ({ context }) => {
	const { navigateToSettingsModelPicker, modelProviderPresets, apiConfiguration } = useSettingsStore()
	const { handleModeFieldChange } = useApiConfigurationHandlers()
	const [modelPresetError, setModelPresetError] = useState<string>()
	const [isActivatingModelPreset, setIsActivatingModelPreset] = useState(false)
	const [reasoningEffortError, setReasoningEffortError] = useState<string>()
	const [isUpdatingReasoningEffort, setIsUpdatingReasoningEffort] = useState(false)
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
	const activeProfileName =
		selectedModelInfo.mode === "plan"
			? apiConfiguration?.planModeOpenAiProfileName
			: apiConfiguration?.actModeOpenAiProfileName
	const activeModelProviderPresetId = modelProviderPresets.find(
		(preset) =>
			preset.provider === selectedModelInfo.selectedProvider &&
			preset.modelId === selectedModelInfo.selectedModelId &&
			(preset.provider !== "openai" || preset.openAiProfileName === activeProfileName),
	)?.id
	const supportsReasoningEffort = supportsReasoningEffortForModelId(
		selectedModelInfo.selectedModelId,
		selectedModelInfo,
	)
	const configuredReasoningEffort =
		selectedModelInfo.mode === "plan"
			? apiConfiguration?.planModeReasoningEffort
			: apiConfiguration?.actModeReasoningEffort
	const modelReasoningEfforts = Array.isArray(selectedModelInfo.reasoningEffortOptions)
		? selectedModelInfo.reasoningEffortOptions.filter(isOpenaiReasoningEffort)
		: []
	const reasoningEffortOptions: readonly OpenaiReasoningEffort[] =
		modelReasoningEfforts.length > 0 ? modelReasoningEfforts : OPENAI_REASONING_EFFORT_OPTIONS
	const reasoningEffort =
		isOpenaiReasoningEffort(configuredReasoningEffort) && reasoningEffortOptions.includes(configuredReasoningEffort)
			? configuredReasoningEffort
			: reasoningEffortOptions.includes("medium")
				? "medium"
				: reasoningEffortOptions[0]

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
				modelProviderPresets={modelProviderPresets}
				activeModelProviderPresetId={activeModelProviderPresetId}
				onModelProviderPresetSelect={async (presetId) => {
					setModelPresetError(undefined)
					setIsActivatingModelPreset(true)
					try {
						await StateServiceClient.activateModelProviderPreset(StringRequest.create({ value: presetId }))
					} catch (error) {
						setModelPresetError(error instanceof Error ? error.message : "Failed to switch models")
					} finally {
						setIsActivatingModelPreset(false)
					}
				}}
				modelPresetError={modelPresetError}
				isActivatingModelPreset={isActivatingModelPreset}
				supportsReasoningEffort={supportsReasoningEffort}
				reasoningEffort={reasoningEffort}
				reasoningEffortOptions={reasoningEffortOptions}
				onReasoningEffortSelect={async (effort) => {
					setReasoningEffortError(undefined)
					setIsUpdatingReasoningEffort(true)
					try {
						await handleModeFieldChange(
							{ plan: "planModeReasoningEffort", act: "actModeReasoningEffort" },
							effort,
							selectedModelInfo.mode,
						)
					} catch (error) {
						setReasoningEffortError(error instanceof Error ? error.message : "Failed to update reasoning effort")
					} finally {
						setIsUpdatingReasoningEffort(false)
					}
				}}
				reasoningEffortError={reasoningEffortError}
				isUpdatingReasoningEffort={isUpdatingReasoningEffort}
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
