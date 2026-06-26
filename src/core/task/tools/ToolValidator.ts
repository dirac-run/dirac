import type { ToolParamName, ToolUse } from "@core/assistant-message"
import type { DiracIgnoreController } from "@core/ignore/DiracIgnoreController"

export type ValidationResult = { ok: true } | { ok: false; error: string }

/**
 * Lightweight validator used by new tool handlers.
 * The legacy ToolExecutor switch remains unchanged and does not depend on this.
 */
export class ToolValidator {
	constructor(private readonly diracIgnoreController: DiracIgnoreController) {}

	/**
	 * Verifies required parameters exist on the tool block.
	 * Returns a message suitable for displaying in an error.
	 */
	assertRequiredParams(block: ToolUse, ...params: ToolParamName[]): ValidationResult {
		for (const p of params) {
			// params are stored under block.params using their tag name
			const val = (block as any)?.params?.[p]
			if (val === undefined || val === null) {
				return { ok: false, error: `Missing required parameter '${p}' for tool '${block.name}'.` }
			}

			if (Array.isArray(val)) {
				if (val.length === 0) {
					return { ok: false, error: `Parameter '${p}' for tool '${block.name}' cannot be an empty array.` }
				}
			} else if (String(val).trim() === "") {
				return { ok: false, error: `Parameter '${p}' for tool '${block.name}' cannot be empty.` }
			}
		}
		return { ok: true }
	}

	/**
	 * Verifies access is allowed to a given path via .diracignore rules.
	 * Callers should pass a repo-relative (workspace-relative) path.
	 */
	checkDiracIgnorePath(relPath: string): ValidationResult {
		const accessAllowed = this.diracIgnoreController.validateAccess(relPath)
		if (!accessAllowed) {
			return {
				ok: false,
				error: `Access to path '${relPath}' is blocked by .diracignore settings.`,
			}
		}
		return { ok: true }
	}
}
