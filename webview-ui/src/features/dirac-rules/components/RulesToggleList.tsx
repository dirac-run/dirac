import NewRuleRow from "./NewRuleRow"
import RuleRow from "./RuleRow"

const RulesToggleList = ({
	rules,
	toggleRule,
	listGap = "medium",
	isGlobal,
	ruleType,
	showNewRule,
	showNoRules,
	isRemote = false,
	alwaysEnabledMap = {},
	onChanged,
}: {
	rules: [string, boolean][]
	toggleRule: (rulePath: string, enabled: boolean) => void
	listGap?: "small" | "medium" | "large"
	isGlobal: boolean
	ruleType: string
	showNewRule: boolean
	showNoRules: boolean
	isRemote?: boolean
	alwaysEnabledMap?: Record<string, boolean>
	onChanged?: () => void
}) => {
	const gapClasses = {
		small: "gap-0",
		medium: "gap-2.5",
		large: "gap-5",
	}

	const gapClass = gapClasses[listGap]

	return (
		<div className={`flex flex-col ${gapClass}`}>
			{rules.length > 0 ? (
				<>
					{rules.map(([rulePath, enabled]) => (
						<RuleRow
							alwaysEnabled={alwaysEnabledMap[rulePath]}
							enabled={enabled}
							isGlobal={isGlobal}
							onDeleted={onChanged}
							isRemote={isRemote}
							key={rulePath}
							rulePath={rulePath}
							ruleType={ruleType}
							toggleRule={toggleRule}
						/>
					))}
					{showNewRule && <NewRuleRow isGlobal={isGlobal} onCreated={onChanged} ruleType={ruleType} />}
				</>
			) : (
				<>
					{showNoRules && (
						<div className="flex flex-col items-center gap-3 my-3 text-(--vscode-descriptionForeground)">
							{ruleType === "workflow" ? "No workflows found" : "No rules found"}
						</div>
					)}
					{showNewRule && <NewRuleRow isGlobal={isGlobal} onCreated={onChanged} ruleType={ruleType} />}
				</>
			)}
		</div>
	)
}

export default RulesToggleList
