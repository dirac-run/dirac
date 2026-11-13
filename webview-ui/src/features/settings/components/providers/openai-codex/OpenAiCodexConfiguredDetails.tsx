import { ChevronDownIcon } from "lucide-react"
import { useEffect, useId, useState } from "react"
import { useSettingsStore } from "@/features/settings/store/settingsStore"
import { Button } from "@/shared/ui/button"
import { OpenAiCodexUsagePanel } from "./OpenAiCodexUsagePanel"

/** Read-only account details for the configured-provider list; setup remains a separate view. */
export function OpenAiCodexConfiguredDetails() {
	const {
		openAiCodexIsAuthenticated,
		openAiCodexEmail,
		openAiCodexUsage,
		openAiCodexUsageRefreshing,
		openAiCodexUsageRefreshError,
		refreshOpenAiCodexUsage,
	} = useSettingsStore()
	const [expanded, setExpanded] = useState(false)
	const detailsId = useId()

	// Viewing details owns its data loading, independently of the setup form or cached data.
	useEffect(() => {
		if (expanded && openAiCodexIsAuthenticated) void refreshOpenAiCodexUsage(false)
	}, [expanded, openAiCodexIsAuthenticated, refreshOpenAiCodexUsage])

	return (
		<div className="mt-2">
			<Button
				aria-controls={detailsId}
				aria-expanded={expanded}
				aria-label={`${expanded ? "Hide" : "Show"} usage/details for ChatGPT`}
				onClick={() => setExpanded((value) => !value)}
				size="sm"
				type="button"
				variant="secondary">
				<ChevronDownIcon aria-hidden="true" className={expanded ? "rotate-180" : undefined} size={14} />
				{expanded ? "Hide usage/details" : "Show usage/details"}
			</Button>
			<div className="mt-2 space-y-3" hidden={!expanded} id={detailsId}>
				{expanded && (openAiCodexIsAuthenticated ? (
					<>
						<div className="text-xs text-description">
							<h4 className="m-0 text-xs font-medium">ChatGPT account</h4>
							<p className="mb-0 mt-1 break-all">{openAiCodexEmail || "ChatGPT user"} · Connected</p>
						</div>
						<OpenAiCodexUsagePanel
							isRefreshing={openAiCodexUsageRefreshing}
							onRefresh={refreshOpenAiCodexUsage}
							refreshError={openAiCodexUsageRefreshError}
							snapshot={openAiCodexUsage}
						/>
					</>
				) : (
					<p className="m-0 text-xs text-description">Not connected. Use Edit setup to sign in to ChatGPT.</p>
				))}
			</div>
		</div>
	)
}
