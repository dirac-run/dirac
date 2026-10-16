import { theme } from "../constants/theme"
/**
 * Model picker component for model selection
 * Supports static model lists and dynamic provider catalogs
 */

import { Box, Text } from "ink"
import Spinner from "ink-spinner"
import React, { useEffect, useMemo, useState } from "react"
import type { Controller } from "@/core/controller"
import { logOpenAiModelsError } from "@/core/controller/models/refreshOpenAiModels"
import { type ApiProvider } from "@/shared/api"
import { filterOpenRouterModelIds } from "@/shared/utils/model-filters"
import { COLORS } from "../constants/colors"
import { Logger } from "@/shared/services/Logger"
import {
	fetchDynamicModels,
	getCustomModelLabel,
	getDefaultModelId,
	getModelList,
	hasDynamicModels,
	hasModelPicker,
	hasStaticModels,
	providerModels,
} from "../utils/model-metadata"
import { usesOpenRouterModels } from "../utils/openrouter-models"
import { SearchableList, SearchableListItem } from "./SearchableList"

// Special ID used to indicate the user wants to enter a custom model ID / ARN
export const CUSTOM_MODEL_ID = "__custom__"

export { getDefaultModelId, getModelList, hasModelPicker, hasStaticModels, providerModels }

interface ModelPickerProps {
	provider: string
	controller?: Controller
	onChange: (modelId: string) => void
	onSubmit: (modelId: string) => void
	isActive?: boolean
	baseUrl?: string
	apiKey?: string
}

export const ModelPicker: React.FC<ModelPickerProps> = ({
	provider,
	controller,
	onChange,
	onSubmit,
	isActive = true,
	baseUrl,
	apiKey,
}) => {
	const [isLoading, setIsLoading] = useState(false)
	const [asyncModels, setAsyncModels] = useState<string[]>([])
	const [loadError, setLoadError] = useState<string | null>(null)

	// Fetch dynamic models when needed
	useEffect(() => {
		if (!hasDynamicModels(provider)) {
			setAsyncModels([])
			setLoadError(null)
			setIsLoading(false)
			return
		}

		let cancelled = false
		setAsyncModels([])
		setLoadError(null)
		setIsLoading(true)

		fetchDynamicModels(provider, { controller, baseUrl, apiKey }).then(
			(models) => {
				if (cancelled) return
				const modelIds = Object.keys(models).sort((a, b) => a.localeCompare(b))
				if (modelIds.length === 0) {
					setLoadError("The provider returned no models.")
				}
				setAsyncModels(
					usesOpenRouterModels(provider) ? filterOpenRouterModelIds(modelIds, provider as ApiProvider) : modelIds,
				)
				setIsLoading(false)
			},
			(error) => {
				const message =
					provider === "openai"
						? logOpenAiModelsError(error)
						: error instanceof Error
							? error.message
							: String(error)
				if (provider !== "openai") Logger.error(`Failed to load models for ${provider}:`, error)
				if (cancelled) return
				setLoadError(message)
				setIsLoading(false)
			},
		)

		return () => {
			cancelled = true
		}
	}, [provider, controller, baseUrl, apiKey])

	const fallbackModels = useMemo(() => getModelList(provider), [provider])
	const modelList = useMemo(() => {
		if (!hasDynamicModels(provider)) return fallbackModels
		return asyncModels.length ? asyncModels : fallbackModels
	}, [provider, asyncModels, fallbackModels])

	const customModelLabel = getCustomModelLabel(provider)
	const supportsCustomModel = Boolean(customModelLabel)

	const items: SearchableListItem[] = useMemo(() => {
		const list = modelList.map((modelId) => ({
			id: modelId,
			label: modelId,
		}))
		if (customModelLabel) {
			list.push({
				id: CUSTOM_MODEL_ID,
				label: customModelLabel,
			})
		}
		return list
	}, [modelList, customModelLabel])

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
				<Text color={theme.muted}> Loading models...</Text>
			</Box>
		)
	}

	if (loadError && !supportsCustomModel && !fallbackModels.length) {
		return <Text color={theme.error}>Could not load models: {loadError}</Text>
	}

	return (
		<Box flexDirection="column">
			{loadError && (
				<Text color={theme.warning}>
					{fallbackModels.length
						? "Model list unavailable; showing fallback models."
						: provider === "openai"
							? `${loadError} Select Custom Model ID / Preset below.`
							: "Model list unavailable; enter a custom model ID."}
				</Text>
			)}
			<SearchableList
				isActive={isActive}
				items={items}
				onSelect={(item) => {
					onChange(item.id)
					onSubmit(item.id)
				}}
			/>
		</Box>
	)
}
