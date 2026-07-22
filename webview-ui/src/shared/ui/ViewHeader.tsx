import { getEnvironmentColor } from "@/shared/lib/environmentColors"
import { Button } from "@/shared/ui/button"
import type { Environment } from "../../../../src/shared/config-types"

const ENV_DISPLAY_NAMES: Record<Environment, string> = {
	production: "Production",
	staging: "Staging",
	local: "Local",
	selfHosted: "Self-hosted",
}

type ViewHeaderProps = {
	title: string
	onDone: () => void
	showEnvironmentSuffix?: boolean
	environment?: Environment
}

const ViewHeader = ({ title, onDone, showEnvironmentSuffix, environment }: ViewHeaderProps) => {
	const showSubtext = showEnvironmentSuffix && environment && environment !== "production"
	const capitalizedEnv = environment ? ENV_DISPLAY_NAMES[environment] : ""
	const titleColor = getEnvironmentColor(environment)

	return (
		<div className="mb-2 flex items-center justify-between border-b border-border-panel px-4 py-3">
			<div>
				<h3 className="m-0 text-md font-medium tracking-tight" style={{ color: titleColor }}>
					{title}
				</h3>
				{showSubtext && (
					<span className="block whitespace-nowrap pt-1 text-xs text-description">{capitalizedEnv} environment</span>
				)}
			</div>
			<Button onClick={onDone} size="header">
				Done
			</Button>
		</div>
	)
}

export default ViewHeader
