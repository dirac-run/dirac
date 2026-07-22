import { isOpenaiReasoningEffort, OPENAI_REASONING_EFFORT_OPTIONS, type OpenaiReasoningEffort } from "@shared/ExtensionMessage"
import { StringRequest } from "@shared/proto/dirac/common"
import React, { useState } from "react"
import { supportsReasoningEffortForModelId } from "@/features/settings/components/utils/providerUtils"
import { useApiConfigurationHandlers } from "@/features/settings/components/utils/useApiConfigurationHandlers"
import { useSettingsStore } from "@/features/settings/store/settingsStore"
import { StateServiceClient } from "@/shared/api/grpc-client"
import QuotedMessagePreview from "@/shared/ui/QuotedMessagePreview"
import { ModularChatTextArea } from "../ModularChatTextArea"
import { ChatSection, ChatViewContext } from "../types"

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
	const supportsReasoningEffort = supportsReasoningEffortForModelId(selectedModelInfo.selectedModelId, selectedModelInfo)
	const configuredReasoningEffort =
		selectedModelInfo.mode === "plan" ? apiConfiguration?.planModeReasoningEffort : apiConfiguration?.actModeReasoningEffort
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
				activeModelProviderPresetId={activeModelProviderPresetId}
				className="mt-2"
				inputValue={inputValue}
				isActivatingModelPreset={isActivatingModelPreset}
				isUpdatingReasoningEffort={isUpdatingReasoningEffort}
				mode={selectedModelInfo.mode}
				modelDisplayName={`${selectedModelInfo.selectedProvider}:${selectedModelInfo.name || selectedModelInfo.selectedModelId}`}
				modelPresetError={modelPresetError}
				modelProviderPresets={modelProviderPresets}
				onHeightChange={() => {
					if (isAtBottomRef.current) {
						scrollToBottomAuto()
					}
				}}
				onModelButtonClick={() => {
					navigateToSettingsModelPicker({ targetSection: "api-config" })
				}}
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
				onReasoningEffortSelect={async (effort) => {
					setReasoningEffortError(undefined)
					setIsUpdatingReasoningEffort(true)
					try {
						const didPersist = await handleModeFieldChange(
							{ plan: "planModeReasoningEffort", act: "actModeReasoningEffort" },
							effort,
							selectedModelInfo.mode,
						)
						if (!didPersist) {
							setReasoningEffortError(
								useSettingsStore.getState().apiConfigurationError || "Failed to update reasoning effort",
							)
						}
					} finally {
						setIsUpdatingReasoningEffort(false)
					}
				}}
				onSelectFilesAndImages={selectFilesAndImages}
				onSend={() => messageHandlers.handleSendMessage(inputValue, selectedImages, selectedFiles)}
				placeholder={placeholderText}
				reasoningEffort={reasoningEffort}
				reasoningEffortError={reasoningEffortError}
				reasoningEffortOptions={reasoningEffortOptions}
				selectedFiles={selectedFiles}
				selectedImages={selectedImages}
				sendingDisabled={chatState.sendingDisabled}
				setInputValue={chatState.setInputValue}
				setSelectedFiles={chatState.setSelectedFiles}
				setSelectedImages={chatState.setSelectedImages}
				shouldDisableFilesAndImages={shouldDisableFilesAndImages}
				supportsReasoningEffort={supportsReasoningEffort}
				taskStatus={taskStatus}
			/>
		</>
	)
}

export const InputSection: ChatSection = {
	id: "input",
	shouldRender: () => true,
	render: (context: ChatViewContext) => <InputSectionContent context={context} />,
}
