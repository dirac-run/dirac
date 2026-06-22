import {
    ActivatedConditionalRule,
    getRemoteRulesTotalContentWithMetadata,
    getRuleFilesTotalContentWithMetadata,
    RULE_SOURCE_PREFIX,
    RuleLoadResultWithInstructions,
    synchronizeRuleToggles,
} from "@core/context/instructions/user-instructions/rule-helpers"
import { formatResponse } from "@core/formatResponse"
import { ensureRulesDirectoryExists, GlobalFileNames } from "@core/storage/disk"
import { StateManager } from "@core/storage/StateManager"
import { DiracRulesToggles } from "@shared/dirac-rules"
import { fileExistsAtPath, isDirectory, readDirectory } from "@utils/fs"
import fs from "fs/promises"
import path from "path"
import { Logger } from "@/shared/services/Logger"
import { parseYamlFrontmatter } from "@utils/frontmatter"
import { evaluateRuleConditionals, type RuleEvaluationContext } from "./rule-conditionals"

export const getGlobalDiracRules = async (
	globalDiracRulesFilePath: string,
	toggles: DiracRulesToggles,
	opts?: { evaluationContext?: RuleEvaluationContext },
): Promise<RuleLoadResultWithInstructions> => {
	let combinedContent = ""
	const activatedConditionalRules: ActivatedConditionalRule[] = []

	// 1. Get file-based rules
	if (await fileExistsAtPath(globalDiracRulesFilePath)) {
		if (await isDirectory(globalDiracRulesFilePath)) {
			try {
				const rulesFilePaths = await readDirectory(globalDiracRulesFilePath)
				// Note: ruleNamePrefix explicitly set to "global" for clarity (matches the default)
				const rulesFilesTotal = await getRuleFilesTotalContentWithMetadata(
					rulesFilePaths,
					globalDiracRulesFilePath,
					toggles,
					{
						evaluationContext: opts?.evaluationContext,
						ruleNamePrefix: "global",
					},
				)
				if (rulesFilesTotal.content) {
					combinedContent = rulesFilesTotal.content
					activatedConditionalRules.push(...rulesFilesTotal.activatedConditionalRules)
				}
			} catch {
				Logger.error(`Failed to read .diracrules directory at ${globalDiracRulesFilePath}`)
			}
		} else {
			Logger.error(`${globalDiracRulesFilePath} is not a directory`)
		}
	}

	// 2. Append remote config rules
	const stateManager = StateManager.get()
	const remoteRules: any[] = []
	const remoteToggles = stateManager.getGlobalStateKey("remoteRulesToggles") || {}
	const remoteResult = getRemoteRulesTotalContentWithMetadata(remoteRules, remoteToggles, {
		evaluationContext: opts?.evaluationContext,
	})
	if (remoteResult.content) {
		if (combinedContent) combinedContent += "\n\n"
		combinedContent += remoteResult.content
		activatedConditionalRules.push(...remoteResult.activatedConditionalRules)
	}

	// 3. Return formatted instructions
	if (!combinedContent) {
		return { instructions: undefined, activatedConditionalRules: [] }
	}

	return {
		instructions: formatResponse.diracRulesGlobalDirectoryInstructions(globalDiracRulesFilePath, combinedContent),
		activatedConditionalRules,
	}
}

export const getLocalDiracRules = async (
	cwd: string,
	toggles: DiracRulesToggles,
	opts?: { evaluationContext?: RuleEvaluationContext },
): Promise<RuleLoadResultWithInstructions> => {
	const diracRulesFilePath = path.resolve(cwd, GlobalFileNames.diracRules)

	let instructions: string | undefined
	const activatedConditionalRules: ActivatedConditionalRule[] = []

	if (await fileExistsAtPath(diracRulesFilePath)) {
		if (await isDirectory(diracRulesFilePath)) {
			try {
				const rulesFilePaths = await readDirectory(diracRulesFilePath, [
					[".diracrules", "workflows"],
					[".diracrules", "hooks"],
					[".diracrules", "skills"],
				])

				const rulesFilesTotal = await getRuleFilesTotalContentWithMetadata(rulesFilePaths, cwd, toggles, {
					evaluationContext: opts?.evaluationContext,
					ruleNamePrefix: "workspace",
				})
				if (rulesFilesTotal.content) {
					instructions = formatResponse.diracRulesLocalDirectoryInstructions(cwd, rulesFilesTotal.content)
					activatedConditionalRules.push(...rulesFilesTotal.activatedConditionalRules)
				}
			} catch {
				Logger.error(`Failed to read .diracrules directory at ${diracRulesFilePath}`)
			}
		} else {
			try {
				if (diracRulesFilePath in toggles && toggles[diracRulesFilePath] !== false) {
					const raw = (await fs.readFile(diracRulesFilePath, "utf8")).trim()
					if (raw) {
						// Keep single-file .diracrules behavior consistent with directory/remote rules:
						// - Parse YAML frontmatter (fail-open on parse errors)
						// - Evaluate conditionals against the request's evaluation context
						const parsed = parseYamlFrontmatter(raw)
						if (parsed.hadFrontmatter && parsed.parseError) {
							// Fail-open: preserve the raw contents so the LLM can still see the author's intent.
							instructions = formatResponse.diracRulesLocalFileInstructions(cwd, raw)
						} else {
							const { passed, matchedConditions } = evaluateRuleConditionals(
								parsed.data,
								opts?.evaluationContext ?? {},
							)
							if (passed) {
								instructions = formatResponse.diracRulesLocalFileInstructions(cwd, parsed.body.trim())
								if (parsed.hadFrontmatter && Object.keys(matchedConditions).length > 0) {
									activatedConditionalRules.push({
										name: `${RULE_SOURCE_PREFIX.workspace}:${GlobalFileNames.diracRules}`,
										matchedConditions,
									})
								}
							}
						}
					}
				}
			} catch {
				Logger.error(`Failed to read .diracrules file at ${diracRulesFilePath}`)
			}
		}
	}

	return { instructions, activatedConditionalRules }
}

export async function refreshDiracRulesToggles(
	stateManager: StateManager,
	workingDirectory: string,
): Promise<{
	globalToggles: DiracRulesToggles
	localToggles: DiracRulesToggles
}> {
	// Global toggles
	const globalDiracRulesToggles = stateManager.getGlobalSettingsKey("globalDiracRulesToggles")
	const globalDiracRulesFilePath = await ensureRulesDirectoryExists()
	const updatedGlobalToggles = await synchronizeRuleToggles(globalDiracRulesFilePath, globalDiracRulesToggles)
	stateManager.setGlobalState("globalDiracRulesToggles", updatedGlobalToggles)

	// Local toggles
	const localDiracRulesToggles = stateManager.getWorkspaceStateKey("localDiracRulesToggles")
	const localDiracRulesFilePath = path.resolve(workingDirectory, GlobalFileNames.diracRules)
	const updatedLocalToggles = await synchronizeRuleToggles(localDiracRulesFilePath, localDiracRulesToggles, "", [
		[".diracrules", "workflows"],
		[".diracrules", "hooks"],
		[".diracrules", "skills"],
	])
	stateManager.setWorkspaceState("localDiracRulesToggles", updatedLocalToggles)

	return {
		globalToggles: updatedGlobalToggles,
		localToggles: updatedLocalToggles,
	}
}
