/**
 * Model picker component for model selection
 * Supports static model lists and async loading for OpenRouter
 */

import { Box, Text } from "ink"
import Spinner from "ink-spinner"
import React, { useEffect, useMemo, useState } from "react"
import { refreshOpenRouterModels } from "@/core/controller/models/refreshOpenRouterModels"
import { refreshGithubCopilotModels } from "@/core/controller/models/refreshGithubCopilotModels"
import { type ApiProvider } from "@/shared/api"
import { filterOpenRouterModelIds } from "@/shared/utils/model-filters"
import { COLORS } from "../constants/colors"
import { getDefaultModelId, getModelList, hasModelPicker, hasStaticModels, providerModels } from "../utils/model-metadata"
import { usesOpenRouterModels } from "../utils/openrouter-models"
import { SearchableList, SearchableListItem } from "./SearchableList"

// Special ID used to indicate the user wants to enter a custom model ID / ARN
export const CUSTOM_MODEL_ID = "__custom__"

export { getDefaultModelId, getModelList, hasModelPicker, hasStaticModels, providerModels }

interface ModelPickerProps {
	provider: string
	controller: any
	onChange: (modelId: string) => void
	onSubmit: (modelId: string) => void
	isActive?: boolean
}

export const ModelPicker: React.FC<ModelPickerProps> = ({ provider, controller, onChange, onSubmit, isActive = true }) => {
	const [isLoading, setIsLoading] = useState(false)
	const [asyncModels, setAsyncModels] = useState<string[]>([])

	// Fetch async models (OpenRouter) when needed
	useEffect(() => {
		if (usesOpenRouterModels(provider)) {
			setIsLoading(true)
			refreshOpenRouterModels(controller)
				.then((models) => {
					const modelIds = Object.keys(models).sort((a, b) => a.localeCompare(b))
					const filtered = filterOpenRouterModelIds(modelIds, provider as ApiProvider)
					setAsyncModels(filtered)
				})
				.finally(() => {
					setIsLoading(false)
				})
		}

		if (provider === "github-copilot") {
			setIsLoading(true)
			refreshGithubCopilotModels()
				.then((models) => {
					setAsyncModels(Object.keys(models).sort((a, b) => a.localeCompare(b)))
				})
				.finally(() => {
					setIsLoading(false)
				})
		}
	}, [provider, controller])

	const modelList = useMemo(() => {
		if (usesOpenRouterModels(provider) || provider === "github-copilot") {
			return asyncModels
		}
		return getModelList(provider)
	}, [provider, asyncModels])

	// Providers that support custom model IDs (e.g., Bedrock Application Inference Profiles)
	const supportsCustomModel = provider === "bedrock" || usesOpenRouterModels(provider)

	const items: SearchableListItem[] = useMemo(() => {
		const list = modelList.map((modelId) => ({
			id: modelId,
			label: modelId,
		}))
		// Add "Custom" option at the end for providers that support it
		if (supportsCustomModel) {
			const label = usesOpenRouterModels(provider) ? "Custom Model ID / Preset" : "Custom (ARN / Inference Profile)"
			list.push({
				id: CUSTOM_MODEL_ID,
				label,
			})
		}
		return list
	}, [modelList, supportsCustomModel, provider])

	// For providers without a model picker, render nothing
	if (!hasModelPicker(provider)) {
		return null
	}

	// Show loading state for async providers
	if (isLoading) {
		return (
			<Box>
				<Text color={COLORS.primaryBlue}>
					<Spinner type="dots" />
				</Text>
				<Text color="gray"> Loading models...</Text>
			</Box>
		)
	}

	// If async fetch returned no models, render nothing
	if ((usesOpenRouterModels(provider) || provider === "github-copilot") && modelList.length === 0) {
		return null
	}

	return (
		<SearchableList
			isActive={isActive}
			items={items}
			onSelect={(item) => {
				onChange(item.id)
				onSubmit(item.id)
			}}
		/>
	)
}
