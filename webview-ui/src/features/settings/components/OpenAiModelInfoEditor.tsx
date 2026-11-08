import { type OpenAiCompatibleModelInfo, openAiModelInfoSaneDefaults } from "@shared/api"
import { DebouncedTextField } from "./common/DebouncedTextField"
import { parsePrice } from "./utils/pricingUtils"

/** Endpoint model metadata is owned by the selection, not the saved access profile. */
export function OpenAiModelInfoEditor({ value = openAiModelInfoSaneDefaults, onChange }: {
	value?: OpenAiCompatibleModelInfo
	onChange: (value: OpenAiCompatibleModelInfo) => void
}) {
	return <details><summary>Model configuration</summary>
		<label><input type="checkbox" checked={value.supportsImages ?? false} onChange={(event) => onChange({ ...value, supportsImages: event.target.checked })} />Supports images</label>
		<label><input type="checkbox" checked={value.isR1FormatRequired ?? false} onChange={(event) => onChange({ ...value, isR1FormatRequired: event.target.checked })} />Enable R1 messages format</label>
		{(["contextWindow", "maxTokens", "inputPrice", "outputPrice", "temperature"] as const).map((field) => <DebouncedTextField key={field}
			initialValue={(value[field] ?? openAiModelInfoSaneDefaults[field])?.toString() ?? ""}
			onChange={(text) => onChange({ ...value, [field]: field === "contextWindow" || field === "maxTokens" ? Number(text) : parsePrice(text, openAiModelInfoSaneDefaults[field] ?? 0) })}>
			{({ contextWindow: "Context Window", maxTokens: "Max Output", inputPrice: "Input Price / 1M", outputPrice: "Output Price / 1M", temperature: "Temperature" })[field]}
		</DebouncedTextField>)}
	</details>
}
