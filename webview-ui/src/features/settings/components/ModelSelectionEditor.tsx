import {
	ALL_MODEL_MAPS,
	type ApiProvider,
	type ModelInfo,
	type ModelProviderSelection,
	type OpenAiCompatibleProfile,
	openAiModelInfoSaneDefaults,
} from "@shared/api"
import PROVIDERS from "@shared/providers/providers.json"
import { getReasoningEffortOptionsForModel, resolveReasoningEffortForModel } from "@shared/utils/reasoning-support"
import { type ReactNode, useEffect, useMemo, useRef, useState } from "react"
import equal from "fast-deep-equal"
import { useShallow } from "zustand/react/shallow"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/shared/ui/select"
import { Popover, PopoverContent, PopoverTrigger } from "@/shared/ui/popover"
import { useSettingsStore } from "@/features/settings/store/settingsStore"
import { ModelsServiceClient } from "@/shared/api/grpc-client"
import { OpenAiModelsRequest } from "@shared/proto/dirac/models"
import { EmptyRequest } from "@shared/proto/dirac/common"
import { bedrockModels, bedrockDefaultModelId } from "@shared/api"
import type { LanguageModelChatSelector } from "@shared/vsCodeSelectorUtils"
import { fromProtobufModelInfo } from "@shared/proto-conversions/models/typeConversion"
import { ModelAutocomplete } from "./common/ModelAutocomplete"
import { ReasoningEffortInput } from "./ReasoningEffortSelector"
import { AdaptiveThinkingInput } from "./AdaptiveThinkingToggle"
import { ThinkingBudgetInput } from "./ThinkingBudgetSlider"
import { normalizeApiConfiguration } from "./utils/providerUtils"
import { OpenAiModelInfoEditor } from "./OpenAiModelInfoEditor"
import { internationalQwenModels, mainlandQwenModels, internationalZAiModels, mainlandZAiModels } from "@shared/api"

interface Props {
	label: string
	selection?: ModelProviderSelection
	onChange: (selection: ModelProviderSelection) => void
	allowCustomModelId: (provider: ApiProvider) => boolean
	onValidityChange?: (valid: boolean) => void
	renderControls?: (selection: ModelProviderSelection) => ReactNode
	renderOptions?: (selection: ModelProviderSelection) => ReactNode
}

/** Selection UI owns no persistence destination; callers bind main modes or independent selections. */
export function ModelSelectionEditor({
	label,
	selection,
	onChange,
	allowCustomModelId,
	onValidityChange,
	renderControls,
	renderOptions,
}: Props) {
	const configured = useSettingsStore((state) => state.configuredApiProviders)
	const apiConfiguration = useSettingsStore(useShallow((state) => ({
		openAiCompatibleProfiles: state.apiConfiguration.openAiCompatibleProfiles,
		openAiBaseUrl: state.apiConfiguration.openAiBaseUrl,
		openAiApiKey: state.apiConfiguration.openAiApiKey,
		openAiCompatibleCustomApiKey: state.apiConfiguration.openAiCompatibleCustomApiKey,
		openAiHeaders: state.apiConfiguration.openAiHeaders,
		unbiasedApiKey: state.apiConfiguration.unbiasedApiKey,
		aihubmixApiKey: state.apiConfiguration.aihubmixApiKey,
		aihubmixBaseUrl: state.apiConfiguration.aihubmixBaseUrl,
		lmStudioBaseUrl: state.apiConfiguration.lmStudioBaseUrl,
		qwenApiLine: state.apiConfiguration.qwenApiLine,
		zaiApiLine: state.apiConfiguration.zaiApiLine,
	})))
	const pendingUnbiasedKey = useSettingsStore((state) => Object.hasOwn(state.pendingApiConfigurationUpdates, "unbiasedApiKey"))
	const profiles: OpenAiCompatibleProfile[] = apiConfiguration.openAiCompatibleProfiles ?? []
	const [draft, setDraft] = useState(selection)
	const previousSelection = useRef(selection)
	useEffect(() => {
		// State snapshots and edits to another row must not discard an unfinished provider/ARN draft.
		if (equal(previousSelection.current, selection)) return
		previousSelection.current = selection
		setDraft(selection)
	}, [selection])
	const current = draft ?? selection
	const valid =
		!current || (!!current.modelId.trim() && (!current.awsBedrockCustomSelected || current.modelId.startsWith("arn:")))
	useEffect(() => onValidityChange?.(valid), [valid, onValidityChange])
	const [endpointModels, setEndpointModels] = useState<Record<string, ModelInfo>>({})
	const [error, setError] = useState<string>()
	const [providerCatalog, setProviderCatalog] = useState<Record<string, ModelInfo>>({})
	useEffect(() => {
		let active = true
		setProviderCatalog({})
		if (
			current?.provider === "unbiased" &&
			apiConfiguration.unbiasedApiKey &&
			!pendingUnbiasedKey
		) {
			void ModelsServiceClient.refreshUnbiasedModelsRpc(EmptyRequest.create({}))
				.then((response) => {
					if (active)
						setProviderCatalog(
							Object.fromEntries(
								Object.entries(response.models).map(([id, info]) => [
									id,
									{ ...fromProtobufModelInfo(info), name: info.name, supportsTools: info.supportsTools },
								]),
							),
						)
				})
				.catch((cause: unknown) => {
					if (active) setError(String(cause))
				})
		}
		if (current?.provider === "aihubmix") {
			void ModelsServiceClient.getAihubmixModels(EmptyRequest.create({}))
				.then((response) => {
					if (active) setProviderCatalog(response.models as Record<string, ModelInfo>)
				})
				.catch((cause: unknown) => {
					if (active) setError(String(cause))
				})
		}
		return () => {
			active = false
		}
	}, [
		current?.provider,
		apiConfiguration.unbiasedApiKey,
		pendingUnbiasedKey,
		apiConfiguration.aihubmixApiKey,
		apiConfiguration.aihubmixBaseUrl,
	])
	const [vsCodeModels, setVsCodeModels] = useState<LanguageModelChatSelector[]>([])
	const [lmStudioModels, setLmStudioModels] = useState<Record<string, ModelInfo>>({})
	useEffect(() => {
		if (current?.provider !== "lmstudio") return
		let active = true
		setLmStudioModels({})
		void ModelsServiceClient.getLmStudioModels({ value: apiConfiguration.lmStudioBaseUrl || "http://localhost:1234" })
			.then((response) => {
				const models: Record<string, ModelInfo> = {}
				for (const item of response.values) {
					const model = JSON.parse(item) as { id: string; loaded_context_length?: number; max_context_length?: number }
					models[model.id] = {
						supportsPromptCache: false,
						contextWindow: model.loaded_context_length ?? model.max_context_length,
					}
				}
				if (active) setLmStudioModels(models)
			})
			.catch((cause: unknown) => {
				if (active) setError(String(cause))
			})
		return () => {
			active = false
		}
	}, [current?.provider, apiConfiguration.lmStudioBaseUrl])
	useEffect(() => {
		if (current?.provider !== "vscode-lm") return
		let active = true
		void ModelsServiceClient.getVsCodeLmModels(EmptyRequest.create({}))
			.then((response) => {
				if (active) setVsCodeModels(response.models)
			})
			.catch((cause: unknown) => {
				if (active) setError(String(cause))
			})
		return () => {
			active = false
		}
	}, [current?.provider])
	useEffect(() => {
		const store = useSettingsStore.getState()
		const refresh: Partial<Record<ApiProvider, () => void>> = {
			openrouter: store.refreshOpenRouterModels,
			litellm: store.refreshLiteLlmModels,
			requesty: store.refreshRequestyModels,
			groq: store.refreshGroqModels,
			baseten: store.refreshBasetenModels,
			huggingface: store.refreshHuggingFaceModels,
			"vercel-ai-gateway": store.refreshVercelAiGatewayModels,
		}
		if (current) refresh[current.provider]?.()
	}, [current?.provider])
	const profile = profiles.find((entry) => entry.name === current?.openAiProfileName)
	const endpoint = current?.openAiProfileName
		? profile
		: {
			baseUrl: apiConfiguration.openAiBaseUrl,
			apiKey: apiConfiguration.openAiCompatibleCustomApiKey || apiConfiguration.openAiApiKey,
			headers: apiConfiguration.openAiHeaders,
		}
	const endpointHeadersKey = JSON.stringify(Object.entries(endpoint?.headers ?? {}).sort(([a], [b]) => a.localeCompare(b)))
	useEffect(() => {
		let active = true
		setEndpointModels({})
		setError(undefined)
		if (current?.provider !== "openai" || !endpoint?.baseUrl) return
		void ModelsServiceClient.refreshOpenAiModels(
			OpenAiModelsRequest.create(current.openAiProfileName ? {
				baseUrl: endpoint.baseUrl,
				apiKey: endpoint.apiKey ?? "",
				headers: Object.fromEntries(JSON.parse(endpointHeadersKey)),
			} : { useSavedEndpoint: true }),
		)
			.then((response) => {
				if (active)
					setEndpointModels(Object.fromEntries(response.values.map((id) => [id, { ...openAiModelInfoSaneDefaults }])))
			})
			.catch((cause: unknown) => {
				if (active) setError(cause instanceof Error ? cause.message : "Could not load endpoint models")
			})
		return () => {
			active = false
		}
	}, [current?.provider, current?.openAiProfileName, endpoint?.baseUrl, endpoint?.apiKey, endpointHeadersKey])
	const catalog = useSettingsStore((state) => {
		switch (current?.provider) {
			case "openrouter": return state.openRouterModels
			case "litellm": return state.liteLlmModels
			case "requesty": return state.requestyModels
			case "groq": return state.groqModels
			case "baseten": return state.basetenModels
			case "huggingface": return state.huggingFaceModels
			case "vercel-ai-gateway": return state.vercelAiGatewayModels
			case "github-copilot": return state.githubCopilotModels
			default: return undefined
		}
	})
	const models = useMemo<Record<string, ModelInfo>>(() => {
		const provider = current?.provider
		const staticModels = provider === "qwen"
			? apiConfiguration.qwenApiLine === "china" ? mainlandQwenModels : internationalQwenModels
			: provider === "zai"
				? apiConfiguration.zaiApiLine === "china" ? mainlandZAiModels : internationalZAiModels
				: Object.assign({}, ...ALL_MODEL_MAPS.filter(([id]) => id === provider).map(([, entries]) => entries))
		let dynamicModels = catalog
		if (provider === "unbiased" || provider === "aihubmix") dynamicModels = providerCatalog
		if (provider === "lmstudio") dynamicModels = lmStudioModels
		if (provider === "openai") dynamicModels = endpointModels
		if (provider === "vscode-lm") dynamicModels = Object.fromEntries(
			vsCodeModels.map((entry) => [`${entry.vendor ?? ""}/${entry.family ?? ""}`, { supportsPromptCache: false }]),
		)
		if (provider === "dify") {
			const dify = normalizeApiConfiguration({ actModeApiProvider: "dify" }, "act")
			dynamicModels = { [dify.selectedModelId]: dify.selectedModelInfo }
		}
		return { ...staticModels, ...dynamicModels }
	}, [current?.provider, apiConfiguration.qwenApiLine, apiConfiguration.zaiApiLine, catalog, providerCatalog, lmStudioModels, endpointModels, vsCodeModels])
	const choices = configured.flatMap<{ id: string; label: string; provider: ApiProvider; profile?: string }>((provider) => {
		const name = PROVIDERS.list.find((entry) => entry.value === provider)?.label ?? provider
		const legacy = { id: provider, label: name, provider, profile: undefined }
		if (provider !== "openai") return [legacy]
		const named = profiles.map((entry) => ({ id: `openai:${entry.name}`, label: entry.name, provider, profile: entry.name }))
		return apiConfiguration.openAiBaseUrl || apiConfiguration.openAiApiKey || !profiles.length
			? [legacy, ...named]
			: named
	})
	const providerValue = current?.openAiProfileName ? `openai:${current.openAiProfileName}` : (current?.provider ?? "")
	const commit = (next: ModelProviderSelection) => {
		setDraft(next)
		onChange(next)
	}
	const modelInfo = current ? {
		...(current.provider === "bedrock" && current.awsBedrockCustomModelBaseId
			? bedrockModels[current.awsBedrockCustomModelBaseId as keyof typeof bedrockModels]
			: models[current.modelId]),
		...current.modelInfo,
	} : undefined
	const hasKnownCapabilities =
		!!current &&
		(Object.hasOwn(models, current.modelId) ||
			current.awsBedrockCustomSelected ||
			current.modelInfo?.supportsReasoningEffort ||
			current.modelInfo?.reasoningEffortOptions?.length)
	const efforts = hasKnownCapabilities ? getReasoningEffortOptionsForModel(current?.modelId, modelInfo) : []
	const hasThinkingBudget =
		modelInfo?.supportsReasoning &&
		!modelInfo.thinkingAlwaysOn &&
		(efforts.length === 0 || current?.provider === "litellm" || current?.provider === "minimax")
	const hasAdaptiveThinkingToggle = modelInfo?.supportsAdaptiveThinking &&
		modelInfo.supportsReasoningEffort && !modelInfo.thinkingAlwaysOn
	const extraOptions = current ? renderOptions?.(current) : null
	const hasOptions =
		current &&
		(current.provider === "bedrock" ||
			hasThinkingBudget ||
			hasAdaptiveThinkingToggle ||
			(current.provider === "openai" && current.modelId) ||
			extraOptions)
	return (
		<div className="border-b border-(--vscode-panel-border) py-2">
			<div className="flex flex-wrap items-center gap-2" role="group" aria-label={`${label} model configuration`}>
				<span className="min-w-20 text-xs font-medium">{label}</span>
				<Select
					value={providerValue}
					onValueChange={(value) => {
						const choice = choices.find((entry) => entry.id === value)
						if (choice) setDraft({ provider: choice.provider, modelId: "", openAiProfileName: choice.profile })
					}}>
					<SelectTrigger size="sm" aria-label={`${label} provider`} className="h-7 max-w-48 rounded-sm px-2 text-xs">
						<SelectValue placeholder="Select provider" />
					</SelectTrigger>
					<SelectContent align="start" className="max-w-[calc(100vw-24px)] min-w-56">
						{providerValue && !choices.some((entry) => entry.id === providerValue) && (
							<SelectItem value={providerValue} disabled>
								{providerValue} (unavailable)
							</SelectItem>
						)}
						{choices.map((entry) => (
							<SelectItem key={entry.id} value={entry.id}>
								{entry.label}
							</SelectItem>
						))}
						{choices.length === 0 && (
							<div className="px-2 py-2 text-xs text-description">Configure a provider in API providers first.</div>
						)}
					</SelectContent>
				</Select>
				{current && !current.awsBedrockCustomSelected && (
					<ModelAutocomplete
						compact
						label={`${label} model`}
						models={models}
						selectedModelId={current.modelId}
						allowCustomModelId={allowCustomModelId(current.provider)}
						onChange={(modelId, modelInfo) =>
							commit({
								...current,
								modelId,
								modelInfo:
									modelInfo ?? (current.provider === "openai" ? { ...openAiModelInfoSaneDefaults } : undefined),
								vsCodeLmModelSelector:
									current.provider === "vscode-lm"
										? vsCodeModels.find((entry) => `${entry.vendor ?? ""}/${entry.family ?? ""}` === modelId)
										: undefined,
								awsBedrockCustomSelected: false,
								reasoningEffort: undefined,
								thinkingBudgetTokens: undefined,
								geminiThinkingLevel: undefined,
							})
						}
					/>
				)}
				{current?.awsBedrockCustomSelected && (
					<span className="max-w-48 truncate text-xs" title={current.modelId}>
						{current.modelId || "Set inference profile in Options"}
					</span>
				)}
				{current?.modelId && efforts.length > 0 && (
					<ReasoningEffortInput
						compact
						label={`${label} reasoning effort`}
						value={current.reasoningEffort}
						allowedEfforts={efforts}
						defaultEffort={resolveReasoningEffortForModel(current.modelId, current.modelInfo)}
						onChange={(reasoningEffort) => commit({ ...current, reasoningEffort })}
					/>
				)}
				{current?.modelId && renderControls?.(current)}
				{hasOptions && (
					<Popover>
						<PopoverTrigger asChild>
							<button
								type="button"
								aria-label={`${label} options`}
								className="h-7 rounded-sm border border-(--vscode-dropdown-border) px-2 text-xs hover:bg-(--vscode-list-hoverBackground) focus-visible:outline focus-visible:outline-(--vscode-focusBorder)">
								Options
							</button>
						</PopoverTrigger>
						<PopoverContent
							align="start"
							className="w-96 max-w-[calc(100vw-24px)] max-h-[min(70vh,600px)] overflow-y-auto space-y-3 p-3">
							<div className="text-sm font-medium">{label} options</div>
							{current.provider === "bedrock" && (
								<label className="flex items-center gap-2 text-xs">
									<input
										type="checkbox"
										checked={current.awsBedrockCustomSelected ?? false}
										onChange={(event) =>
											setDraft({
												...current,
												awsBedrockCustomSelected: event.target.checked,
												modelId: "",
												awsBedrockCustomModelBaseId: bedrockDefaultModelId,
											})
										}
									/>
									Application inference profile ARN
								</label>
							)}
							{current.provider === "bedrock" && current.awsBedrockCustomSelected && (
								<>
									<input
										className="w-full rounded-sm border border-(--vscode-input-border) bg-(--vscode-input-background) px-2 py-1 text-xs"
										aria-label={`${label} inference profile ARN`}
										placeholder="arn:aws:bedrock:..."
										value={current.modelId}
										onChange={(event) => setDraft({ ...current, modelId: event.target.value })}
										onBlur={() => {
											if (current.modelId.startsWith("arn:")) commit(current)
										}}
									/>
									<ModelAutocomplete
										compact
										label={`${label} base model`}
										models={bedrockModels}
										allowCustomModelId={false}
										selectedModelId={current.awsBedrockCustomModelBaseId}
										onChange={(modelId, modelInfo) => {
											const next = { ...current, awsBedrockCustomModelBaseId: modelId, modelInfo }
											if (current.modelId.startsWith("arn:")) commit(next)
											else setDraft(next)
										}}
									/>
								</>
							)}
							{hasAdaptiveThinkingToggle && (
								<AdaptiveThinkingInput
									budgetTokens={current.thinkingBudgetTokens}
									effort={current.reasoningEffort}
									supportsBetweenToolsThinking={modelInfo?.supportsBetweenToolsThinking}
									onChange={(thinkingBudgetTokens) => commit({ ...current, thinkingBudgetTokens })}
								/>
							)}
							{hasThinkingBudget && (
								<ThinkingBudgetInput
									showEnableToggle={current.provider !== "minimax"}
									value={current.thinkingBudgetTokens}
									maxBudget={current.modelInfo?.thinkingConfig?.maxBudget}
									onChange={(thinkingBudgetTokens) => commit({ ...current, thinkingBudgetTokens })}
								/>
							)}
							{current.provider === "openai" && current.modelId && (
								<OpenAiModelInfoEditor
									value={current.modelInfo}
									onChange={(modelInfo) => commit({ ...current, modelInfo })}
								/>
							)}
							{extraOptions}
						</PopoverContent>
					</Popover>
				)}
			</div>
			{error && (
				<p role="alert" className="mt-1 text-xs text-error">
					{error}
				</p>
			)}
		</div>
	)
}
